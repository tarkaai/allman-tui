import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const testOnSupportedPlatform = ["darwin", "linux"].includes(process.platform) ? test : test.skip;
const installer = resolve(import.meta.dir, "../../install.sh");

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function runInstaller(ghToken?: string) {
  tempDir = mkdtempSync(join(tmpdir(), "allman-install-"));
  const fakeBin = join(tempDir, "fake-bin");
  const home = join(tempDir, "home");
  mkdirSync(fakeBin);
  mkdirSync(home);

  const os = process.platform === "darwin" ? "darwin" : "linux";
  const asset = `allman-tui-${os}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  const fakeCurl = join(fakeBin, "curl");
  writeFileSync(
    fakeCurl,
    `#!/bin/sh
out=""
url=""
auth=""
accept=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -H)
      case "$2" in
        Authorization:*) auth="$2" ;;
        Accept:*) accept="$2" ;;
      esac
      shift 2
      ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [ "$REQUIRE_AUTH" = "1" ] && [ "$auth" != "Authorization: Bearer test-token" ]; then
  echo "missing bearer auth" >&2
  exit 42
fi
case "$url" in
  'https://api.github.com/repos/tarkaai/allman-tui/releases?per_page=1')
    [ -z "$out" ] || exit 43
    printf '%s\\n' '[{"tag_name":"test-release","assets":[{"name":"${asset}","id":1}]}]'
    ;;
  'https://api.github.com/repos/tarkaai/allman-tui/releases/assets/1')
    [ "$accept" = "Accept: application/octet-stream" ] || exit 44
    printf '%s\\n' '#!/bin/sh' 'echo allman test binary' > "$out"
    ;;
  *) echo "unexpected URL: $url" >&2; exit 45 ;;
esac
`,
  );
  chmodSync(fakeCurl, 0o755);

  const prefix = join(home, ".local");
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    PREFIX: prefix,
    VERSION: "latest",
    REQUIRE_AUTH: ghToken ? "1" : "0",
  };
  if (ghToken) env.GH_TOKEN = ghToken;
  else delete env.GH_TOKEN;

  return {
    binary: join(prefix, "bin/allman-tui"),
    result: Bun.spawnSync(["/bin/bash", installer], { env }),
  };
}

describe("install.sh", () => {
  testOnSupportedPlatform("installs without a GitHub token", () => {
    const { binary, result } = runInstaller();

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(binary)).toBe(true);
  });

  testOnSupportedPlatform("authenticates metadata and asset requests with GH_TOKEN", () => {
    const { binary, result } = runInstaller("test-token");

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(binary)).toBe(true);
  });
});
