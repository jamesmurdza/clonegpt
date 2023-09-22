import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import Docker from 'dockerode'
import * as dotenv from "dotenv"
import packageInfo from './package.json';

import {
  createContainer,
  startContainer,
  runCommandInContainer,
  runScriptInContainer,
  copyFileToContainer,
  readFileFromContainer
} from "./container"
import { llmRequest, Completion } from "./llm"
import { applyCorrections } from "./corrections"
import { newProjectPrompt, changeProjectPrompt, planChangesPrompt } from "./prompt"
import { createGitHubRepo, addGitHubCollaborator, correctBranchName } from "./github"
import * as scripts from "./scripts"
import { BuildPlan } from "./buildPlan"

dotenv.config()

// Container constants:
const baseImage = "node:latest"
const containerHome = "/app/"

// OpenAI constants:
const gptModel = "gpt-3.5-turbo"
const temperature = 0.2
const maxPromptLength = 5500

// Reading and writing files:
async function writeFile(path: string, contents: string): Promise<void> {
  await fs.promises.writeFile(path, contents)
  console.log(`Wrote: ${path}`)
}

type BuildType = "REPOSITORY" | "BRANCH" | "TEMPLATE"
type BuildConstructorProps = {
  userInput: string,      // User prompt
  buildType: BuildType,   // Build type
  suggestedName: string,  // Name of new repository or branch
  creator: string,        // Username to create the repository with
  sourceGitURL?: string,  // Repository to branch from
  sourceBranch?: string,  // Branch to branch from
  organization?: string,  // Oganization to create the repository under
  collaborator?: string,  // User to add as a collaborator
}

// Project generation
export class Build {
  // Input parameters to create a build:
  userInput: string
  isBranch?: boolean = false
  isCopy?: boolean = false
  suggestedName: string
  sourceGitURL?: string
  sourceBranch?: string
  creator: string
  organization?: string
  collaborator?: string

  // Generated values:
  completion?: any
  planCompletion?: any
  fileList?: string
  buildPlan?: BuildPlan

  // Output parameters:
  buildScript?: string
  buildLog?: string
  outputGitURL?: string
  outputHTMLURL?: string

  constructor(props: BuildConstructorProps) {
    // To create a new project:
    this.suggestedName = props.suggestedName // The suggested name of the branch
    this.userInput = props.userInput // The description of the project.

    // The username(s) to create the repository under.
    this.creator = props.creator
    this.organization = props.organization
    this.collaborator = props.collaborator

    // To create a new branch or fork:
    this.isBranch = props.buildType === "BRANCH"
    this.isCopy = props.buildType === "TEMPLATE"

    if (this.isBranch || this.isCopy) {
      if (!props.sourceGitURL) {
        throw new Error("Source repository is required to make a branch.")
      }
      this.sourceGitURL = props.sourceGitURL // The source repository URL.
      this.sourceBranch = props.sourceBranch // The source branch name.
    }

  }

  // Generate a build script to create a new repository.
  private getCompletion = async (): Promise<Completion | undefined> => {

    console.log("Calling on the great machine god...")

    // Generate a new repository from an empty directory.
    const prompt = newProjectPrompt
      .replace("{REPOSITORY_NAME}", this.suggestedName)
      .replace("{DESCRIPTION}", this.userInput)
      .replace("{BASE_IMAGE}", baseImage);

    this.completion = await llmRequest(prompt.slice(-maxPromptLength), {
      model: gptModel,
      user: this.collaborator ?? this.creator,
      temperature: temperature
    });

    console.log("Prayers were answered. (1/1)");

    return this.completion
  }

  // Generate a plan to modify an existing repository.
  private getPlanCompletion = async (): Promise<Completion | undefined> => {

    console.log("Generating plan...")

    // Prompt to generate the build plan.
    const prompt = planChangesPrompt
      .replace("{DESCRIPTION}", this.userInput)
      .replace("{FILE_LIST}", this.fileList ?? "");

    this.planCompletion = await llmRequest(prompt.slice(-maxPromptLength), {
      model: gptModel,
      user: this.collaborator ?? this.creator,
      temperature: temperature
    });
    console.log("Completion received. (1/2)")

    return this.planCompletion;
  }

  // Generate a build script to modify an existing repository.
  private getBranchCompletion = async (previewContext: string, fileContentsContext: string): Promise<Completion | undefined> => {

    // Prompt to generate the build script.
    const fullPrompt = changeProjectPrompt
      .replace("{DESCRIPTION}", this.userInput)
      .replace("{FILE_CONTENTS}", fileContentsContext)
      .replace("{CHANGE_PREVIEW}", previewContext);

    this.completion = await llmRequest(fullPrompt.slice(-maxPromptLength), {
      model: gptModel,
      user: this.collaborator ?? this.creator,
      temperature: temperature
    });

    console.log("Completion received. (2/2)");

    return this.completion
  }

  buildAndPush = async ({
    debug = false,
    onStatusUpdate = async ({ }) => { },
  } = {}) => {

    // This function pushes a status update to the database.
    const updateStatus = async ({ finished = false } = {}) => {
      await onStatusUpdate({
        outputGitURL: this.outputGitURL,
        outputHTMLURL: this.outputHTMLURL,
        buildScript: this.buildScript,
        buildLog: this.buildLog,
        buildPlan: this.planCompletion?.text,
        completionId: this.completion?.id,
        planCompletionId: this.planCompletion?.id,
        gptModel: this.completion?.model,
        gitwitVersion: packageInfo.version,
        finished: finished
      })
    }

    // Build directory
    const buildDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gitwit-")) + "/"
    console.log(`Created temporary directory: ${buildDirectory} `)

    // Get the name of the source repository as username/reponame.
    const regex = /\/\/github\.com\/([\w-]+)\/([\w-]+)\.git/
    const [, sourceRepositoryUser, sourceRepositoryName] = this.sourceGitURL?.match(regex) ?? []

    // Intermediate build script.
    const buildScriptPath = buildDirectory + "build.sh"
    const buildLogPath = buildDirectory + "build.log"

    // If we're creating a new repository, call the OpenAI API already.
    if (!this.isBranch && !this.isCopy && !this.completion) {
      await this.getCompletion()
    }

    let repositoryName: string | undefined;
    let branchName;

    if (this.isBranch) {
      // Use the provided repository.
      repositoryName = sourceRepositoryName;
      console.log(`Using repository: ${this.sourceGitURL} `)

      // Find an available branch name.
      branchName = await correctBranchName(
        process.env.GITHUB_TOKEN!,
        `${sourceRepositoryUser}/${sourceRepositoryName}`,
        this.suggestedName!
      )
      this.outputGitURL = this.sourceGitURL;
      const sourceHTMLRoot = this.sourceGitURL?.replace(".git", "");
      this.outputHTMLURL = `${sourceHTMLRoot}/tree/${branchName}`;
      console.log(`Creating branch: ${branchName}`)
    } else {

      // Create a new GitHub repository.
      const template = { owner: sourceRepositoryUser!, repository: sourceRepositoryName! };
      const templateOptions = this.isCopy ? { template } : undefined
      const newRepository: any = await createGitHubRepo({
        token: process.env.GITHUB_TOKEN!,
        name: this.suggestedName,
        org: this.organization,
        description: this.userInput,
        ...templateOptions
      });

      // Outputs from the new repository.
      this.outputGitURL = newRepository.clone_url
      this.outputHTMLURL = newRepository.html_url
      repositoryName = newRepository.name
      console.log(`Created repository: ${newRepository.html_url}`)

      // Add the user as a collaborator on the GitHub repository.
      if (newRepository.full_name && this.collaborator) {
        const result = this.collaborator ? await addGitHubCollaborator(
          process.env.GITHUB_TOKEN!,
          newRepository.full_name,
          this.collaborator!
        ) : null
        console.log(`Added ${this.collaborator} to ${newRepository.full_name}.`)
      }
    }

    if (this.isCopy) {
      await updateStatus({ finished: true });
    } else {
      // Define the parameters used by the scripts.
      let parameters = {
        REPO_NAME: repositoryName!,
        FULL_REPO_NAME: `${sourceRepositoryUser}/${sourceRepositoryName}`,
        PUSH_URL: this.outputGitURL!,
        REPO_DESCRIPTION: this.userInput!,
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL!,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME!,
        GITHUB_USERNAME: process.env.GITHUB_USERNAME!,
        GITHUB_TOKEN: process.env.GITHUB_TOKEN!,
        GITWIT_VERSION: packageInfo.version,
        BRANCH_NAME: branchName ?? "",
        SOURCE_BRANCH_NAME: this.sourceBranch ?? "",
        GITHUB_ACCOUNT: this.creator,
      }

      // Connect to Docker...
      console.log(
        "Connecting to Docker on "
        + (process.env.DOCKER_API_HOST ?? "localhost")
        + (process.env.DOCKER_API_PORT ? `:${process.env.DOCKER_API_PORT}` : "")
      );
      const docker = new Docker({
        host: process.env.DOCKER_API_HOST,
        port: process.env.DOCKER_API_PORT,
        // Flightcontrol doesn't support environment variables with newlines.
        ca: process.env.DOCKER_API_CA?.replace(/\\n/g, "\n"),
        cert: process.env.DOCKER_API_CERT?.replace(/\\n/g, "\n"),
        key: process.env.DOCKER_API_KEY?.replace(/\\n/g, "\n"),
        // We use HTTPS when there is an SSL key.
        protocol: process.env.DOCKER_API_KEY ? 'https' : undefined,
      })

      // Create a new docker container.
      const container = await createContainer(docker, baseImage)
      console.log(`Container ${container.id} created.`)

      // Start the container.
      await startContainer(container)
      console.log(`Container ${container.id} started.`)

      // Copy the metadata file to the container.
      await runCommandInContainer(container, ["mkdir", containerHome])

      // These scripts are appended together to maintain the current directory.
      if (this.isBranch) {
        await runScriptInContainer(container,
          scripts.SETUP_GIT_CONFIG +  // Setup the git commit author
          scripts.CLONE_PROJECT_REPO,
          parameters);

        // Get a list of files in the repository.
        this.fileList = await runScriptInContainer(container,
          scripts.GET_FILE_LIST,
          parameters, true);

        // Use ChatGPT to generate a plan.
        await this.getPlanCompletion()
        this.buildPlan = new BuildPlan(
          this.planCompletion.text,
          this.fileList.split('\n')
        )
        console.log(this.buildPlan.items)
        await updateStatus()

        // Get contents of the files to modify.
        const planContext = this.buildPlan.readableString()
        const contentsContext = await this.buildPlan.readableContents(
          async (filePath: string) => {
            return await readFileFromContainer(container, `/root/${repositoryName}/${filePath}`)
          })

        // Use ChatGPT to generate the build script.
        await this.getBranchCompletion(planContext, contentsContext)
      }

      // Generate the build script from the OpenAI completion.
      this.buildScript = applyCorrections(this.completion.text.trim())
      await updateStatus()

      await writeFile(buildScriptPath, this.buildScript)
      await copyFileToContainer(container, buildScriptPath, containerHome)

      if (this.isBranch) {
        // Run the build script on a new branch, and push it to GitHub.
        await runScriptInContainer(container,
          scripts.CREATE_NEW_BRANCH +
          scripts.RUN_BUILD_SCRIPT +
          scripts.CD_GIT_ROOT +
          scripts.SETUP_GIT_CREDENTIALS +
          scripts.PUSH_BRANCH,
          parameters)
      } else {
        await runScriptInContainer(container,
          // Run the build script in an empty directory, and push the results to GitHub.
          scripts.SETUP_GIT_CONFIG +
          scripts.MAKE_PROJECT_DIR +
          scripts.RUN_BUILD_SCRIPT +
          scripts.CD_GIT_ROOT +
          scripts.SETUP_GIT_CREDENTIALS +
          scripts.PUSH_TO_REPO,
          parameters)
      }

      this.buildLog = await runScriptInContainer(container,
        scripts.GET_BUILD_LOG,
        parameters, true);

      await updateStatus({ finished: true });

      if (debug) {
        // This is how we can debug the build script interactively.
        console.log("The container is still running!")
        console.log("To debug, run:")
        console.log("-----")
        console.log(`docker exec -it ${container.id} bash`)
        console.log("-----")
        // If we don't this, the process won't end because the container is running.
        process.exit()
      } else {
        // Stop and remove the container.
        await container.stop()
        console.log(`Container ${container.id} stopped.`)
        await container.remove()
        console.log(`Container ${container.id} removed.`)
      }
    }
  }
}
