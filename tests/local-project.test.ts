import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, type Db } from "../src/lib/db";
import { _setKeyForTests } from "../src/lib/crypto";
import { createHost } from "../src/lib/hosts";
import {
  createProject,
  getProject,
  listProjects,
} from "../src/lib/projects";
import {
  createInstanceRow,
  getInstance,
} from "../src/lib/instances";

let db: Db;
let tmpRoot: string;
const { privateKey } = crypto.generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

beforeEach(() => {
  _setKeyForTests(crypto.randomBytes(32));
  db = createDb(":memory:");
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dcm-local-"));
  process.env.DCM_WORKFLOWS_DIR = tmpRoot;
});
afterEach(() => {
  _setKeyForTests(null);
  db.close();
  delete process.env.DCM_WORKFLOWS_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("local-only projects (host_id = null)", () => {
  it("createProject accepts null host_id", () => {
    const p = createProject(
      {
        name: "local-proj",
        source_type: "local",
        path_on_host: "/tmp/my-project",
      },
      db
    );
    expect(p.host_id).toBeNull();
    expect(p.clone_status).toBe("skipped");
  });

  it("createProject accepts explicit null host_id for git projects", () => {
    const p = createProject(
      {
        name: "local-git",
        source_type: "git",
        git_url: "https://github.com/x/y.git",
        host_id: null,
        path_on_host: "/tmp/local-git",
      },
      db
    );
    expect(p.host_id).toBeNull();
    expect(p.clone_status).toBe("pending");
  });

  it("listProjects round-trips null host_id", () => {
    createProject(
      {
        name: "p1",
        source_type: "local",
        path_on_host: "/tmp/a",
      },
      db
    );
    // also a remote one to cover both branches
    const host = createHost(
      { name: "h", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
      db
    );
    createProject(
      {
        name: "p2",
        source_type: "local",
        host_id: host.id,
        path_on_host: "/tmp/b",
      },
      db
    );
    const list = listProjects(db);
    const local = list.find((p) => p.name === "p1");
    const remote = list.find((p) => p.name === "p2");
    expect(local!.host_id).toBeNull();
    expect(remote!.host_id).toBe(host.id);
  });
});

describe("local instances (host_id = null)", () => {
  it("createInstanceRow from a local project produces null host_id", () => {
    const p = createProject(
      {
        name: "lp",
        source_type: "local",
        path_on_host: "/tmp/x",
      },
      db
    );
    const inst = createInstanceRow({ name: "i", project_id: p.id }, db);
    expect(inst.host_id).toBeNull();
    expect(inst.tmux_session).toBe(`dcm-${inst.id}`);
    // reload from DB to confirm round-trip
    const reloaded = getInstance(inst.id, db)!;
    expect(reloaded.host_id).toBeNull();
  });

  it("project.host_id inherited when instance host_id not specified", () => {
    const host = createHost(
      { name: "h", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
      db
    );
    const p = createProject(
      {
        name: "rp",
        source_type: "local",
        host_id: host.id,
        path_on_host: "/tmp/r",
      },
      db
    );
    const inst = createInstanceRow({ name: "i2", project_id: p.id }, db);
    expect(inst.host_id).toBe(host.id);
  });

  it("explicit host_id on instance overrides project default", () => {
    const host = createHost(
      { name: "h", address: "a", ssh_user: "u", auth_method: "privkey", privkey: PEM },
      db
    );
    const p = createProject(
      {
        name: "pp",
        source_type: "local",
        path_on_host: "/tmp/p",
      },
      db
    );
    expect(getProject(p.id, db)!.host_id).toBeNull();
    const inst = createInstanceRow(
      { name: "override", project_id: p.id, host_id: host.id },
      db
    );
    expect(inst.host_id).toBe(host.id);
  });
});
