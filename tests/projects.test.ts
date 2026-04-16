import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { createDb, type Db } from "../src/lib/db";
import { _setKeyForTests } from "../src/lib/crypto";
import { createHost } from "../src/lib/hosts";
import {
  createProject,
  deleteProject,
  dirname,
  getProject,
  listProjects,
  redactGitCredentials,
  shQuote,
  tryClaimCloning,
  updateProject,
  validateBranch,
  validateGitUrl,
  validatePath,
  validateProjectName,
} from "../src/lib/projects";

let db: Db;
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

beforeEach(() => {
  _setKeyForTests(crypto.randomBytes(32));
  db = createDb(":memory:");
});
afterEach(() => {
  _setKeyForTests(null);
  db.close();
});

function mkHost() {
  return createHost(
    { name: "h1", address: "10.0.0.1", ssh_user: "u", auth_method: "privkey", privkey: PEM },
    db
  );
}

describe("project validators", () => {
  it("project name", () => {
    expect(validateProjectName("ok")).toBeNull();
    expect(validateProjectName("-bad")).not.toBeNull();
    expect(validateProjectName("a b")).not.toBeNull();
  });
  it("git url accepts common forms", () => {
    expect(validateGitUrl("https://github.com/x/y.git")).toBeNull();
    expect(validateGitUrl("git@github.com:x/y.git")).toBeNull();
    expect(validateGitUrl("ssh://git@host/x.git")).toBeNull();
  });
  it("git url rejects shell metachars and dodgy schemes", () => {
    expect(validateGitUrl("file:///etc/passwd")).not.toBeNull();
    expect(validateGitUrl("git://x/y.git")).not.toBeNull();  // unauthenticated git:// is disallowed
    expect(validateGitUrl("https://x' --upload-pack=rm /")).not.toBeNull();
    expect(validateGitUrl("https://x;rm -rf /")).not.toBeNull();
    expect(validateGitUrl("https://x`whoami`")).not.toBeNull();
    expect(validateGitUrl("")).not.toBeNull();
    expect(validateGitUrl("https://-oProxyCommand=evil/y.git")).not.toBeNull();
  });
  it("git url rejects embedded passwords but allows bare user@ (for ssh)", () => {
    expect(validateGitUrl("https://user:token@github.com/x.git")).not.toBeNull();
    expect(validateGitUrl("ssh://user:pass@host/x.git")).not.toBeNull();
    // bare user@ is fine for ssh — `git@github.com` is not a password
    expect(validateGitUrl("https://user@github.com/x.git")).toBeNull();
  });
  it("branch", () => {
    expect(validateBranch("main")).toBeNull();
    expect(validateBranch("feat/x-1")).toBeNull();
    expect(validateBranch("-dash")).not.toBeNull();
    expect(validateBranch("with space")).not.toBeNull();
    expect(validateBranch("with;semi")).not.toBeNull();
  });
  it("path must be absolute and safe", () => {
    expect(validatePath("/home/u/project")).toBeNull();
    expect(validatePath("~/project")).toBeNull();
    expect(validatePath("relative")).not.toBeNull();
    expect(validatePath("/home/u/../etc/passwd")).not.toBeNull();
    expect(validatePath("/home/u;rm -rf /")).not.toBeNull();
    expect(validatePath("/home/u\0null")).not.toBeNull();
    expect(validatePath("/'bad")).not.toBeNull();
  });
  it("path rejects bare / or ~/", () => {
    expect(validatePath("/")).not.toBeNull();
    expect(validatePath("~/")).not.toBeNull();
  });
});

describe("redactGitCredentials", () => {
  it("strips http(s) credentials", () => {
    expect(redactGitCredentials("fatal: https://user:token@github.com/x bad"))
      .toBe("fatal: https://github.com/x bad");
  });
  it("strips ssh credentials", () => {
    expect(redactGitCredentials("ssh://user:pass@host/x.git"))
      .toBe("ssh://host/x.git");
  });
  it("passes strings without credentials unchanged", () => {
    expect(redactGitCredentials("plain error")).toBe("plain error");
  });
});

describe("shQuote", () => {
  it("wraps plain", () => {
    expect(shQuote("plain")).toBe("'plain'");
  });
  it("escapes single quote", () => {
    expect(shQuote("a'b")).toBe("'a'\\''b'");
  });
  it("handles empty", () => {
    expect(shQuote("")).toBe("''");
  });
});

describe("dirname", () => {
  it("simple", () => {
    expect(dirname("/home/u/proj")).toBe("/home/u");
    expect(dirname("/a")).toBe("/");
    expect(dirname("~/p")).toBe("~");
  });
});

describe("project CRUD", () => {
  it("creates local project with skipped status", () => {
    const host = mkHost();
    const p = createProject(
      {
        name: "p1",
        source_type: "local",
        host_id: host.id,
        path_on_host: "/home/u/p1",
      },
      db
    );
    expect(p.source_type).toBe("local");
    expect(p.clone_status).toBe("skipped");
    expect(p.git_url).toBeNull();
  });

  it("creates git project with pending status", () => {
    const host = mkHost();
    const p = createProject(
      {
        name: "p2",
        source_type: "git",
        git_url: "https://github.com/x/y.git",
        git_branch: "main",
        host_id: host.id,
        path_on_host: "/home/u/p2",
      },
      db
    );
    expect(p.source_type).toBe("git");
    expect(p.clone_status).toBe("pending");
    expect(p.git_url).toBe("https://github.com/x/y.git");
  });

  it("rejects git project without git_url", () => {
    const host = mkHost();
    expect(() =>
      createProject(
        { name: "bad", source_type: "git", host_id: host.id, path_on_host: "/home/u/x" },
        db
      )
    ).toThrow();
  });

  it("rejects unknown host_id", () => {
    expect(() =>
      createProject(
        { name: "bad", source_type: "local", host_id: 999, path_on_host: "/x" },
        db
      )
    ).toThrow(/host/);
  });

  it("rejects duplicate name", () => {
    const host = mkHost();
    createProject(
      { name: "dup", source_type: "local", host_id: host.id, path_on_host: "/x" },
      db
    );
    expect(() =>
      createProject(
        { name: "dup", source_type: "local", host_id: host.id, path_on_host: "/y" },
        db
      )
    ).toThrow();
  });

  it("update + delete + list", () => {
    const host = mkHost();
    const p = createProject(
      { name: "p", source_type: "local", host_id: host.id, path_on_host: "/p" },
      db
    );
    const u = updateProject(p.id, { description: "new desc", path_on_host: "/new/p" }, db)!;
    expect(u.description).toBe("new desc");
    expect(u.path_on_host).toBe("/new/p");
    expect(listProjects(db)).toHaveLength(1);
    expect(deleteProject(p.id, db)).toBe(true);
    expect(getProject(p.id, db)).toBeNull();
  });

  it("cannot update git_url on local project", () => {
    const host = mkHost();
    const p = createProject(
      { name: "p", source_type: "local", host_id: host.id, path_on_host: "/p" },
      db
    );
    expect(() => updateProject(p.id, { git_url: "https://example.com/x.git" }, db)).toThrow();
  });
});

describe("tryClaimCloning", () => {
  it("returns true for first claim, false for second", () => {
    const host = mkHost();
    const p = createProject(
      { name: "p", source_type: "git", git_url: "https://github.com/x/y.git", host_id: host.id, path_on_host: "/p" },
      db
    );
    expect(tryClaimCloning(p.id, db)).toBe(true);
    expect(tryClaimCloning(p.id, db)).toBe(false);
  });
});
