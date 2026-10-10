import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { githubAppConfiguration } from "./github-app-manifest";

export type GitHubAppConfiguration = ReturnType<typeof githubAppConfiguration>;
export async function saveGitHubAppConfiguration(
  path: string,
  configuration: GitHubAppConfiguration,
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(configuration));
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function readGitHubAppConfiguration(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 40000 ||
      stat.uid !== process.getuid?.()
    )
      throw Error("GITHUB_APP_PRIVATE_CONFIGURATION_INVALID");
    return githubAppConfiguration(JSON.parse(await file.readFile("utf8")) as unknown);
  } finally {
    await file.close();
  }
}
