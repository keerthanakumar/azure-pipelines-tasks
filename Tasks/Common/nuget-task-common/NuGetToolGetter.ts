import * as toolLib from 'vsts-task-tool-lib/tool';
import * as taskLib from 'vsts-task-lib/task';
import * as restm from 'typed-rest-client/RestClient';
import * as ifm from 'typed-rest-client/Interfaces';
import * as path from 'path';
import * as commandHelper from './CommandHelper';
interface INuGetTools {
    nugetexe: INuGetVersionInfo[]
}

interface INuGetVersionInfo {
    version: string,
    url: string,
    stage: NuGetReleaseStage
}

enum NuGetReleaseStage {
    "EarlyAccessPreview",
    "Released",
    "ReleasedAndBlessed"
}

const NUGET_TOOL_NAME: string = 'NuGet';
const NUGET_EXE_FILENAME: string = 'nuget.exe';

export const FORCE_NUGET_4_0_0: string = 'FORCE_NUGET_4_0_0';
export const NUGET_VERSION_4_0_0: string = '4.0.0';
export const NUGET_VERSION_4_0_0_PATH_SUFFIX: string = 'NuGet/4.0.0/';
export const DEFAULT_NUGET_VERSION: string = '4.1.0';
export const DEFAULT_NUGET_PATH_SUFFIX: string = 'NuGet/4.1.0/';
export const NUGET_EXE_TOOL_PATH_ENV_VAR: string = 'NuGetExeToolPath';
export const NUGET_VERSIONS_URL = 'https://dist.nuget.org/tools.json';

export async function getNuGet(versionSpec: string, checkLatest?: boolean, addNuGetToPath?: boolean): Promise<string> {
    if (toolLib.isExplicitVersion(versionSpec)) {
        // Check latest doesn't make sense when explicit version
        checkLatest = false;
        taskLib.debug('Exact match expected on version: ' + versionSpec);
    }
    else {
        taskLib.debug('Query match expected on version: ' + versionSpec);
        console.log(taskLib.loc("Info_ExpectBehaviorChangeWhenUsingVersionQuery"));
    }

    // If we're not checking latest, check the cache first
    let toolPath: string;
    if (!checkLatest) {
        taskLib.debug('Trying to get tool from local cache');
        toolPath = toolLib.findLocalTool(NUGET_TOOL_NAME, versionSpec);
    }

    let localVersions: string[] = toolLib.findLocalToolVersions(NUGET_TOOL_NAME);
    let version: string = toolLib.evaluateVersions(localVersions, versionSpec);

    if (toolPath) {
        // If here, then we're not checking latest and we found the tool in cache
        console.log(taskLib.loc("Info_ResolvedToolFromCache", version));
    }
    else {
        let versionInfo: INuGetVersionInfo = await getLatestMatchVersionInfo(versionSpec);

        // There is a local version which matches the spec yet we found one on dist.nuget.org
        // which is different, so we're about to change the version which was used
        if (version && version !== versionInfo.version) {
            taskLib.warning(taskLib.loc("Warning_UpdatingNuGetVersion", versionInfo.version, version));
        }

        version = versionInfo.version;
        taskLib.debug('Found the following version from the list: ' + version);

        if (!versionInfo.url) {
            taskLib.error(taskLib.loc("Error_NoUrlWasFoundWhichMatches", version));
            throw new Error(taskLib.loc("Error_NuGetToolInstallerFailer", NUGET_TOOL_NAME));
        }

        toolPath = toolLib.findLocalTool(NUGET_TOOL_NAME, version);

        if (!toolPath) {
            taskLib.debug('Downloading version: ' + version);
            let downloadPath: string = await toolLib.downloadTool(versionInfo.url);

            taskLib.debug('Caching file');
            toolLib.cacheFile(downloadPath, NUGET_EXE_FILENAME, NUGET_TOOL_NAME, version);
        }
    }

    console.log(taskLib.loc("Info_UsingVersion", version));
    toolPath = toolLib.findLocalTool(NUGET_TOOL_NAME, version);

    if (addNuGetToPath) {
        console.log(taskLib.loc("Info_UsingToolPath", toolPath));
        toolLib.prependPath(toolPath);
    }

    let fullNuGetPath: string = path.join(toolPath, NUGET_EXE_FILENAME);
    taskLib.setVariable(NUGET_EXE_TOOL_PATH_ENV_VAR, fullNuGetPath);

    return fullNuGetPath;
}

export async function cacheBundledNuGet() {
    let cachedVersionToUse = DEFAULT_NUGET_VERSION;
    let nugetPathSuffix = DEFAULT_NUGET_PATH_SUFFIX;
    if (taskLib.getVariable(FORCE_NUGET_4_0_0) &&
        taskLib.getVariable(FORCE_NUGET_4_0_0).toLowerCase() === "true") {
        cachedVersionToUse = NUGET_VERSION_4_0_0;
        nugetPathSuffix = NUGET_VERSION_4_0_0_PATH_SUFFIX;
    }

    if (!toolLib.findLocalTool(NUGET_TOOL_NAME, cachedVersionToUse)) {
        taskLib.debug(`Placing bundled NuGet.exe ${cachedVersionToUse} in tool lib cache`);

        let bundledNuGet4Location: string = getBundledNuGet_Location([nugetPathSuffix]);
        toolLib.cacheFile(bundledNuGet4Location, NUGET_EXE_FILENAME, NUGET_TOOL_NAME, cachedVersionToUse);
    }
}


function GetRestClientOptions(): restm.IRequestOptions {
    let options: restm.IRequestOptions = <restm.IRequestOptions>{};

    options.responseProcessor = (obj: any) => {
        return obj['nuget.exe'];
    }
    return options;
}

async function getLatestMatchVersionInfo(versionSpec: string): Promise<INuGetVersionInfo> {
    taskLib.debug('Querying versions list');
    let requestOptions = {
        // ignoreSslError: true,
        proxy: taskLib.getHttpProxyConfiguration(NUGET_VERSIONS_URL)
    } as ifm.IRequestOptions;
    let rest: restm.RestClient = new restm.RestClient('vsts-tasks/NuGetToolInstaller',
        undefined, undefined, requestOptions);
    let nugetVersions: INuGetVersionInfo[];
    try {
        nugetVersions = (await rest.get<INuGetVersionInfo[]>(NUGET_VERSIONS_URL,
            GetRestClientOptions())).result;
    } catch (error) {
        if (error.code) {
            throw new Error(taskLib.loc("Error_NuGetToolInstallerFailer",
                `Unable to reach ${NUGET_VERSIONS_URL}. Code: ${error.code})`));
        }else{
            throw new Error(taskLib.loc("Error_NuGetToolInstallerFailer",
            `Unable to reach ${NUGET_VERSIONS_URL}.`));
        }
    }
    // x.stage is the string representation of the enum, NuGetReleaseStage.Value = number, NuGetReleaseStage[NuGetReleaseStage.Value] = string, NuGetReleaseStage[x.stage] = number
    let releasedVersions: INuGetVersionInfo[] = nugetVersions.filter(x => x.stage.toString() !== NuGetReleaseStage[NuGetReleaseStage.EarlyAccessPreview]);
    let versionStringsFromDist: string[] = releasedVersions.map(x => x.version);

    let version: string = toolLib.evaluateVersions(versionStringsFromDist, versionSpec);
    if (!version) {
        taskLib.error(taskLib.loc("Error_NoVersionWasFoundWhichMatches", versionSpec));
        taskLib.error(taskLib.loc("Info_AvailableVersions", releasedVersions.map(x => x.version).join("; ")));
        throw new Error(taskLib.loc("Error_NuGetToolInstallerFailer", NUGET_TOOL_NAME));
    }

    return releasedVersions.find(x => x.version === version);
}


function getBundledNuGet_Location(nugetPaths: string[]): string {
    let taskNodeModulesPath: string = path.dirname(__dirname);
    let taskRootPath: string = path.dirname(taskNodeModulesPath);
    const toolPath = commandHelper.locateTool("NuGet",
        <commandHelper.LocateOptions>{
            root: taskRootPath,
            searchPath: nugetPaths,
            toolFilenames: ['NuGet.exe', 'nuget.exe'],
        });

    return toolPath;
}