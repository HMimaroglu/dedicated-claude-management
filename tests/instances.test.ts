import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { createDb, type Db } from "../src/lib/db";
import { _setKeyForTests } from "../src/lib/crypto";
import { createHost } from "../src/lib/hosts";
import { createProject } from "../src/lib/projects";
import {
  buildSpawnCommand,
  createInstanceRow,
  deleteInstanceRow,
  getInstance,
  listInstances,
  setInstanceStatus,
  tmuxSessionName,
  validateInstanceName,
} from "../src/lib/instances";

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

function mkHostAndProject() {
  const host = createHost(
    { name: "h1", address: "10.0.0.1", ssh_user: "u", auth_method: "privkey", privkey: PEM },
    db
  );
  const project = createProject(
    { name: "p1", source_type: "local", host_id: host.id, path_on_host: "/home/u/p1" },
    db
  );
  return { host, project };
}

describe("instance validators", () => {
  it("rejects invalid names", () => {
    expect(validateInstanceName("ok")).toBeNull();
    expect(validateInstanceName("-bad")).not.toBeNull();
    expect(validateInstanceName("a b")).not.toBeNull();
  });
});

describe("tmuxSessionName", () => {
  it("derives safe session name", () => {
    expect(tmuxSessionName(42)).toBe("dcm-42");
  });
});

describe("buildSpawnCommand", () => {
  it("shell-quotes path + name, inner command passed to tmux", () => {
    const cmd = buildSpawnCommand({
      projectPath: "/home/u/my proj",
      sessionName: "dcm-1",
      instanceName: "agent-1",
    });
    expect(cmd).toContain("'/home/u/my proj'");
    expect(cmd).toContain("'dcm-1'");
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).toContain("exec claude --dangerously-skip-permissions");
    expect(cmd).toContain("tmux set-option");
  });

  it("escapes single quotes in path", () => {
    const cmd = buildSpawnCommand({
      projectPath: "/home/u/it's",
      sessionName: "dcm-1",
      instanceName: "agent",
    });
    // Single quote should become '\'' — at minimum, no raw ' is left bare
    expect(cmd).toContain("'/home/u/it'\\''s'");
  });
});

describe("instance CRUD", () => {
  it("creates and lists", () => {
    const { project } = mkHostAndProject();
    const inst = createInstanceRow({ name: "i1", project_id: project.id }, db);
    expect(inst.name).toBe("i1");
    expect(inst.tmux_session).toBe(`dcm-${inst.id}`);
    expect(inst.status).toBe("starting");
    expect(listInstances(db)).toHaveLength(1);
  });

  it("rejects duplicate name", () => {
    const { project } = mkHostAndProject();
    createInstanceRow({ name: "dup", project_id: project.id }, db);
    expect(() => createInstanceRow({ name: "dup", project_id: project.id }, db)).toThrow();
  });

  it("rejects unknown project_id", () => {
    expect(() => createInstanceRow({ name: "x", project_id: 999 }, db)).toThrow(/project/);
  });

  it("rejects project with pending clone", () => {
    const host = createHost(
      { name: "h2", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
      db
    );
    const p = createProject(
      { name: "g", source_type: "git", git_url: "https://github.com/x/y.git", host_id: host.id, path_on_host: "/home/u/g" },
      db
    );
    expect(p.clone_status).toBe("pending");
    expect(() => createInstanceRow({ name: "x", project_id: p.id }, db)).toThrow(/clone/);
  });

  it("setInstanceStatus updates fields", () => {
    const { project } = mkHostAndProject();
    const inst = createInstanceRow({ name: "i", project_id: project.id }, db);
    setInstanceStatus(inst.id, "running", { pid: 1234, spawned_at: 9999 }, db);
    const after = getInstance(inst.id, db)!;
    expect(after.status).toBe("running");
    expect(after.pid).toBe(1234);
    expect(after.spawned_at).toBe(9999);
  });

  it("delete works", () => {
    const { project } = mkHostAndProject();
    const inst = createInstanceRow({ name: "i", project_id: project.id }, db);
    expect(deleteInstanceRow(inst.id, db)).toBe(true);
    expect(getInstance(inst.id, db)).toBeNull();
  });
});
