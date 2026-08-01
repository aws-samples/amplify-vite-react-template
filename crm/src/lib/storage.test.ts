import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// aws-amplify/storage is the whole network surface of this module.
const s3 = vi.hoisted(() => ({
  uploadData: vi.fn(),
  getUrl: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("aws-amplify/storage", () => s3);

// ./client calls generateClient() at module scope, so importing anything from
// it would blow up on an unconfigured Amplify. Stubbing generateClient rather
// than the whole ./client module keeps client.ts's real exports intact and
// makes the module-scope call harmless.
const Document = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: { Document } }),
}));

import {
  assertGrantedPath,
  deleteFile,
  downloadFile,
  getFileUrl,
  PENDING_KEY,
  safeSegment,
  uploadAndLink,
  uploadDocument,
  uploadFile,
} from "./storage";

/** uploadData returns a handle whose `.result` is the promise to await. */
function uploadResolves() {
  s3.uploadData.mockReturnValue({ result: Promise.resolve({ path: "ok" }) });
}
function uploadRejects(message: string) {
  const result = Promise.reject(new Error(message));
  result.catch(() => {}); // observed by the code under test, not by the runner
  s3.uploadData.mockReturnValue({ result });
}

function file(name = "budget.pdf", type = "application/pdf") {
  return new File(["x"], name, { type });
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  uploadResolves();
  s3.remove.mockResolvedValue({ path: "gone" });
  s3.getUrl.mockResolvedValue({ url: new URL("https://s3.example/signed?sig=1") });
  Document.create.mockResolvedValue({ data: { id: "doc-1" }, errors: undefined });
  Document.update.mockResolvedValue({
    data: { id: "doc-1", s3Key: "linked" },
    errors: undefined,
  });
  Document.delete.mockResolvedValue({ data: { id: "doc-1" }, errors: undefined });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assertGrantedPath", () => {
  it("accepts a key under each granted prefix", () => {
    for (const path of [
      "documents/ACCOUNT/a1/d1/budget.pdf",
      "certificates/a1/c1.pdf",
      "templates/acord-25.pdf",
      "generated/a1/123-app.pdf",
      "signatures/u1.png",
      "property-photos/a1/coverPhotoKey-front.jpg",
    ]) {
      expect(assertGrantedPath(path)).toBe(path);
    }
  });

  it("refuses a prefix storage never granted", () => {
    expect(() => assertGrantedPath("uploads/a1/thing.pdf")).toThrow(
      /not under a granted storage prefix/
    );
  });

  it("refuses a prefix-lookalike that escapes the granted prefix", () => {
    expect(() => assertGrantedPath("documents/../templates/acord-25.pdf")).toThrow(
      /not a valid object key/
    );
    expect(() => assertGrantedPath("documents//a1/x.pdf")).toThrow(/not a valid object key/);
    expect(() => assertGrantedPath("documents/")).toThrow(/not a valid object key/);
    expect(() => assertGrantedPath("/documents/a1/x.pdf")).toThrow(
      /not under a granted storage prefix/
    );
  });
});

describe("safeSegment", () => {
  it("keeps a filename to one key segment", () => {
    expect(safeSegment("../../templates/acord-25.pdf")).toBe("templates_acord-25.pdf");
    expect(safeSegment("a/b\\c.pdf")).toBe("a_b_c.pdf");
  });

  it("never yields an empty segment", () => {
    expect(safeSegment("..")).toBe("file");
    expect(safeSegment("   ")).toBe("file");
  });
});

describe("uploadFile", () => {
  it("uploads to the given path and returns it", async () => {
    const path = await uploadFile({
      path: "templates/acord-25.pdf",
      data: file(),
      contentType: "application/pdf",
    });

    expect(path).toBe("templates/acord-25.pdf");
    expect(s3.uploadData).toHaveBeenCalledWith({
      path: "templates/acord-25.pdf",
      data: expect.any(File),
      options: { contentType: "application/pdf" },
    });
  });

  it("normalises an empty content type away", async () => {
    await uploadFile({ path: "templates/x.pdf", data: file("x.pdf", ""), contentType: "" });
    expect(s3.uploadData.mock.calls[0][0].options).toEqual({ contentType: undefined });
  });

  it("refuses an ungranted path without touching S3", async () => {
    await expect(uploadFile({ path: "secrets/x.pdf", data: file() })).rejects.toThrow(
      /granted storage prefix/
    );
    expect(s3.uploadData).not.toHaveBeenCalled();
  });

  it("surfaces an upload failure to the caller", async () => {
    uploadRejects("network down");
    await expect(uploadFile({ path: "templates/x.pdf", data: file() })).rejects.toThrow(
      "network down"
    );
  });
});

describe("uploadAndLink", () => {
  it("uploads before linking and returns the link result", async () => {
    const order: string[] = [];
    s3.uploadData.mockImplementation(() => {
      order.push("upload");
      return { result: Promise.resolve({}) };
    });

    const { result, path } = await uploadAndLink({
      path: "generated/a1/123-app.pdf",
      data: file(),
      contentType: "application/pdf",
      pathIsNew: true,
      link: async (p) => {
        order.push("link");
        return { id: "doc-9", s3Key: p };
      },
    });

    expect(order).toEqual(["upload", "link"]);
    expect(path).toBe("generated/a1/123-app.pdf");
    expect(result).toEqual({ id: "doc-9", s3Key: "generated/a1/123-app.pdf" });
  });

  it("never links when the upload fails", async () => {
    uploadRejects("no space");
    const link = vi.fn();

    await expect(
      uploadAndLink({ path: "generated/a1/1.pdf", data: file(), pathIsNew: true, link })
    ).rejects.toThrow("no space");
    expect(link).not.toHaveBeenCalled();
  });

  it("removes the orphaned object when a link to a fresh key fails", async () => {
    await expect(
      uploadAndLink({
        path: "generated/a1/123-app.pdf",
        data: file(),
        pathIsNew: true,
        link: async () => {
          throw new Error("record write rejected");
        },
      })
    ).rejects.toThrow("record write rejected");

    expect(s3.remove).toHaveBeenCalledWith({ path: "generated/a1/123-app.pdf" });
  });

  it("keeps the object when the key may already be referenced", async () => {
    await expect(
      uploadAndLink({
        path: "signatures/u1.png",
        data: file("sig.png", "image/png"),
        pathIsNew: false,
        link: async () => {
          throw new Error("record write rejected");
        },
      })
    ).rejects.toThrow("record write rejected");

    expect(s3.remove).not.toHaveBeenCalled();
  });

  it("rethrows the link error even if the cleanup delete also fails", async () => {
    s3.remove.mockRejectedValue(new Error("delete denied"));

    await expect(
      uploadAndLink({
        path: "generated/a1/123-app.pdf",
        data: file(),
        pathIsNew: true,
        link: async () => {
          throw new Error("record write rejected");
        },
      })
    ).rejects.toThrow("record write rejected");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("orphaned"));
  });
});

describe("uploadDocument", () => {
  const opts = {
    entityType: "ACCOUNT" as const,
    entityId: "acc-1",
    category: "BUDGET" as const,
    file: file(),
  };

  it("creates the record, links the key, then uploads", async () => {
    const order: string[] = [];
    Document.create.mockImplementation(async () => {
      order.push("create");
      return { data: { id: "doc-1" } };
    });
    Document.update.mockImplementation(async (input: { id: string; s3Key: string }) => {
      order.push("update");
      return { data: { id: input.id, s3Key: input.s3Key } };
    });
    s3.uploadData.mockImplementation(() => {
      order.push("upload");
      return { result: Promise.resolve({}) };
    });

    const doc = await uploadDocument(opts);

    expect(order).toEqual(["create", "update", "upload"]);
    expect(Document.create).toHaveBeenCalledWith(
      expect.objectContaining({ s3Key: PENDING_KEY, ocrStatus: "PENDING", name: "budget.pdf" })
    );
    expect(doc.s3Key).toBe("documents/ACCOUNT/acc-1/doc-1/budget.pdf");
    expect(s3.uploadData).toHaveBeenCalledWith({
      path: "documents/ACCOUNT/acc-1/doc-1/budget.pdf",
      data: opts.file,
      options: { contentType: "application/pdf" },
    });
  });

  it("keeps a hostile filename inside the record's own folder", async () => {
    await uploadDocument({ ...opts, file: file("../../../templates/acord-25.pdf") });

    expect(s3.uploadData.mock.calls[0][0].path).toBe(
      "documents/ACCOUNT/acc-1/doc-1/templates_acord-25.pdf"
    );
  });

  it("deletes the ghost record when the upload fails, and rethrows", async () => {
    uploadRejects("upload blew up");

    await expect(uploadDocument(opts)).rejects.toThrow("upload blew up");
    expect(Document.delete).toHaveBeenCalledWith({ id: "doc-1" });
  });

  it("deletes the ghost record when the s3Key link fails", async () => {
    Document.update.mockResolvedValue({ data: null, errors: [{ message: "not authorized" }] });

    await expect(uploadDocument(opts)).rejects.toThrow("not authorized");
    expect(Document.delete).toHaveBeenCalledWith({ id: "doc-1" });
    expect(s3.uploadData).not.toHaveBeenCalled();
  });

  it("surfaces a create failure and never uploads", async () => {
    Document.create.mockResolvedValue({ data: null, errors: [{ message: "quota exceeded" }] });

    await expect(uploadDocument(opts)).rejects.toThrow("quota exceeded");
    expect(s3.uploadData).not.toHaveBeenCalled();
    expect(Document.delete).not.toHaveBeenCalled();
  });

  it("warns, but still reports the upload error, when the ghost record survives", async () => {
    uploadRejects("upload blew up");
    Document.delete.mockResolvedValue({ data: null, errors: [{ message: "delete denied" }] });

    await expect(uploadDocument(opts)).rejects.toThrow("upload blew up");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("doc-1"));
  });
});

describe("downloadFile", () => {
  it("opens a signed url in a new tab", async () => {
    const tab = { closed: false, opener: {} } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(tab);

    const result = await downloadFile("documents/ACCOUNT/a1/d1/budget.pdf");

    expect(s3.getUrl).toHaveBeenCalledWith({
      path: "documents/ACCOUNT/a1/d1/budget.pdf",
      options: { validateObjectExistence: true },
    });
    expect(open).toHaveBeenCalledWith("https://s3.example/signed?sig=1", "_blank");
    expect(result).toEqual({ url: "https://s3.example/signed?sig=1", opened: true });
    expect(tab.opener).toBeNull();
  });

  it("reports a blocked popup instead of looking like a dead button", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    const result = await downloadFile("documents/ACCOUNT/a1/d1/budget.pdf");

    expect(result).toEqual({ url: "https://s3.example/signed?sig=1", opened: false });
  });

  it("throws for a key with no object behind it", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    s3.getUrl.mockRejectedValue(new Error("NoSuchKey"));

    await expect(downloadFile("documents/ACCOUNT/a1/d1/gone.pdf")).rejects.toThrow("NoSuchKey");
    expect(window.open).not.toHaveBeenCalled();
  });

  it("refuses a record whose upload never landed", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    await expect(downloadFile(PENDING_KEY)).rejects.toThrow(/hasn't finished uploading/);
    await expect(downloadFile("")).rejects.toThrow(/hasn't finished uploading/);
    await expect(downloadFile(null)).rejects.toThrow(/hasn't finished uploading/);
    expect(s3.getUrl).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

describe("getFileUrl", () => {
  it("skips the existence check by default", async () => {
    await getFileUrl("signatures/u1.png");
    expect(s3.getUrl).toHaveBeenCalledWith({
      path: "signatures/u1.png",
      options: { validateObjectExistence: false },
    });
  });
});

describe("deleteFile", () => {
  it("removes the object", async () => {
    await expect(deleteFile("documents/ACCOUNT/a1/d1/budget.pdf")).resolves.toEqual({
      status: "deleted",
      path: "documents/ACCOUNT/a1/d1/budget.pdf",
    });
    expect(s3.remove).toHaveBeenCalledWith({ path: "documents/ACCOUNT/a1/d1/budget.pdf" });
  });

  it("skips a key that was never uploaded", async () => {
    await expect(deleteFile(PENDING_KEY)).resolves.toEqual({
      status: "skipped",
      path: PENDING_KEY,
    });
    await expect(deleteFile(null)).resolves.toEqual({ status: "skipped", path: null });
    await expect(deleteFile("  ")).resolves.toEqual({ status: "skipped", path: "  " });
    expect(s3.remove).not.toHaveBeenCalled();
  });

  it("surfaces a failure instead of swallowing it, and does not throw", async () => {
    s3.remove.mockRejectedValue(new Error("AccessDenied"));

    const result = await deleteFile("documents/ACCOUNT/a1/d1/budget.pdf");

    expect(result).toEqual({
      status: "failed",
      path: "documents/ACCOUNT/a1/d1/budget.pdf",
      error: "AccessDenied",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("AccessDenied"));
  });

  it("reports an ungranted path as a failure rather than calling S3", async () => {
    const result = await deleteFile("secrets/x.pdf");

    expect(result.status).toBe("failed");
    expect(s3.remove).not.toHaveBeenCalled();
  });
});
