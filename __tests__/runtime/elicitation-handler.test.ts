import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChildProcess } from "node:child_process";
import type { ElicitRequest } from "@modelcontextprotocol/client";
import type open from "open";
import type { ElicitationUIContext } from "../../elicitation-handler.ts";
import { createElicitationUi } from "./fixtures/elicitation-ui.ts";

const mocks = vi.hoisted(() => ({
  open: vi.fn<typeof open>(),
}));

vi.mock("open", () => ({ default: mocks.open }));

function request(params: ElicitRequest["params"]): ElicitRequest {
  return { method: "elicitation/create", params };
}

describe("MCP elicitation", () => {
  beforeEach(() => {
    mocks.open.mockReset();
    mocks.open.mockResolvedValue(new ChildProcess());
  });

  it("collects a form with stock Pi dialogs and lets the user review it before sending", async () => {
    const { handleElicitationRequest } = await import("../../elicitation-handler.ts");
    const ui = createElicitationUi(["Continue", "Enter value", "Submit"], ["octocat"]);

    const result = await handleElicitationRequest(
      { serverName: "github", ui, allowUrl: true },
      request({
        mode: "form",
        message: "Please provide your GitHub username",
        requestedSchema: {
          type: "object",
          properties: {
            username: { type: "string", title: "GitHub username", minLength: 1 },
          },
          required: ["username"],
        },
      }),
    );

    expect(ui.select.mock.calls[0]).toEqual([
      "MCP Input Request\nServer: github\n\nPlease provide your GitHub username",
      ["Continue", "Decline"],
    ]);
    expect(ui.input).toHaveBeenCalledWith("GitHub username (required)", undefined);
    expect(ui.select.mock.calls[2]?.[0]).toContain("GitHub username: octocat");
    expect(result).toEqual({ action: "accept", content: { username: "octocat" } });
  });

  it("lets the user edit a value from the review screen", async () => {
    const { handleElicitationRequest } = await import("../../elicitation-handler.ts");
    const ui = createElicitationUi(
      ["Continue", "Enter value", "Edit", "Name (name)", "Enter value", "Submit"],
      ["Old", "New"],
    );

    const result = await handleElicitationRequest(
      { serverName: "demo", ui, allowUrl: true },
      request({
        mode: "form",
        message: "Choose a name",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string", title: "Name" } },
        },
      }),
    );

    expect(ui.input.mock.calls[1]).toEqual(["Name", "Old"]);
    expect(result).toEqual({ action: "accept", content: { name: "New" } });
  });

  it("validates form values and lets the user correct invalid input", async () => {
    const { handleElicitationRequest } = await import("../../elicitation-handler.ts");
    const ui = createElicitationUi(
      ["Continue", "Enter value", "Enter value", "Submit"],
      ["not-an-email", "octocat@example.com"],
    );

    const result = await handleElicitationRequest(
      { serverName: "demo", ui, allowUrl: true },
      request({
        mode: "form",
        message: "Contact details",
        requestedSchema: {
          type: "object",
          properties: {
            email: { type: "string", format: "email" },
          },
          required: ["email"],
        },
      }),
    );

    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("email"), "error");
    expect(result).toEqual({ action: "accept", content: { email: "octocat@example.com" } });
  });

  it.each([
    ["number", false],
    ["number", true],
    ["integer", false],
    ["integer", true],
  ] as const)("rejects blank %s input and reprompts when required=%s", async (type, required) => {
    const { handleElicitationRequest } = await import("../../elicitation-handler.ts");
    const ui = createElicitationUi(
      ["Continue", "Enter value", "Enter value", "Submit"],
      ["   ", "7"],
    );

    const result = await handleElicitationRequest(
      { serverName: "demo", ui, allowUrl: false },
      request({
        mode: "form",
        message: "Choose a quantity",
        requestedSchema: {
          type: "object",
          properties: { quantity: { type } },
          ...(required ? { required: ["quantity"] } : {}),
        },
      }),
    );

    expect(ui.notify).toHaveBeenCalledWith("Elicitation field quantity must be a number", "error");
    expect(ui.input).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ action: "accept", content: { quantity: 7 } });
  });

  it("maps explicit refusal and dialog dismissal to decline and cancel", async () => {
    const { handleElicitationRequest } = await import("../../elicitation-handler.ts");
    const params = request({
      mode: "form",
      message: "Provide a value",
      requestedSchema: { type: "object", properties: {} },
    });

    await expect(
      handleElicitationRequest(
        {
          serverName: "demo",
          ui: createElicitationUi(["Decline"]),
          allowUrl: true,
        },
        params,
      ),
    ).resolves.toEqual({ action: "decline" });
    await expect(
      handleElicitationRequest(
        {
          serverName: "demo",
          ui: createElicitationUi(),
          allowUrl: true,
        },
        params,
      ),
    ).resolves.toEqual({ action: "cancel" });
  });

  it("dismisses open dialogs when the owning runtime signal aborts", async () => {
    const { handleElicitationRequest } = await import("../../elicitation-handler.ts");
    const controller = new AbortController();
    let dismissed = false;
    // Mirror Pi's dialog behavior: an aborted dialog signal resolves the dialog as dismissed.
    const awaitDismissal = async (signal: AbortSignal | undefined): Promise<void> => {
      if (signal === undefined) {
        throw new Error("test dialog expected a bound signal");
      }
      if (signal.aborted) {
        dismissed = true;
        return;
      }
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            dismissed = true;
            resolve();
          },
          { once: true },
        );
      });
    };
    const ui = {
      select: vi.fn<ElicitationUIContext["select"]>(async (_title, _choices, opts) => {
        await awaitDismissal(opts?.signal);
      }),
      input: vi.fn<ElicitationUIContext["input"]>(async () => "unused"),
      notify: vi.fn<ElicitationUIContext["notify"]>(),
    };

    const pending = handleElicitationRequest(
      { serverName: "demo", ui, allowUrl: false, signal: controller.signal },
      request({
        mode: "form",
        message: "Choose",
        requestedSchema: { type: "object", properties: {} },
      }),
    );
    expect(ui.select).toHaveBeenCalled();
    expect(ui.select.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
    controller.abort(new Error("session ended"));
    await expect(pending).resolves.toEqual({ action: "cancel" });
    expect(dismissed).toBe(true);
  });

  it("does not open URL elicitations that are declined or dismissed", async () => {
    const { handleElicitationRequest } = await import("../../elicitation-handler.ts");
    const params = request({
      mode: "url",
      message: "Authorize",
      elicitationId: "auth-1",
      url: "https://example.com/authorize",
    });

    await expect(
      handleElicitationRequest(
        {
          serverName: "demo",
          ui: createElicitationUi(["Decline"]),
          allowUrl: true,
        },
        params,
      ),
    ).resolves.toEqual({ action: "decline" });
    await expect(
      handleElicitationRequest(
        {
          serverName: "demo",
          ui: createElicitationUi(),
          allowUrl: true,
        },
        params,
      ),
    ).resolves.toEqual({ action: "cancel" });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("shows the server, host, and full URL before opening an accepted URL elicitation", async () => {
    const { handleElicitationRequest } = await import("../../elicitation-handler.ts");
    const onUrlAccepted = vi.fn<(elicitationId: string) => void>();
    const ui = createElicitationUi(["Open"]);
    const url = "https://checkout.example.com/authorize?state=a%2Fb";

    const result = await handleElicitationRequest(
      { serverName: "payments", ui, allowUrl: true, onUrlAccepted },
      request({
        mode: "url",
        message: "Authorize the payment provider",
        elicitationId: "payment-1",
        url,
      }),
    );

    expect(ui.select).toHaveBeenCalledWith(
      [
        "MCP Browser Request",
        "Server: payments",
        "",
        "Authorize the payment provider",
        "",
        "Host: checkout.example.com",
        `Full URL: ${url}`,
        "",
        "Open this URL in your browser?",
      ].join("\n"),
      ["Open", "Decline"],
    );
    expect(mocks.open).toHaveBeenCalledWith(url);
    expect(onUrlAccepted).toHaveBeenCalledWith("payment-1");
    expect(result).toEqual({ action: "accept" });
  });

  it("rejects URL mode when the client advertised form-only support", async () => {
    const { handleElicitationRequest } = await import("../../elicitation-handler.ts");
    const ui = createElicitationUi();

    await expect(
      handleElicitationRequest(
        { serverName: "demo", ui, allowUrl: false },
        request({
          mode: "url",
          message: "Authorize",
          elicitationId: "auth-1",
          url: "https://example.com/authorize",
        }),
      ),
    ).rejects.toMatchObject({ code: -32602 });
    expect(ui.select).not.toHaveBeenCalled();
  });

  it("rejects URL schemes that cannot be opened safely in a browser", async () => {
    const { handleElicitationRequest } = await import("../../elicitation-handler.ts");
    const ui = createElicitationUi();

    await expect(
      handleElicitationRequest(
        { serverName: "demo", ui, allowUrl: true },
        request({
          mode: "url",
          message: "Open a file",
          elicitationId: "file-1",
          url: "file:///etc/passwd",
        }),
      ),
    ).rejects.toMatchObject({ code: -32602 });
    expect(ui.select).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("cancels URL elicitation when the browser cannot be opened", async () => {
    const { handleElicitationRequest } = await import("../../elicitation-handler.ts");
    mocks.open.mockRejectedValueOnce(new Error("no browser"));
    const ui = createElicitationUi(["Open"]);

    const result = await handleElicitationRequest(
      { serverName: "demo", ui, allowUrl: true },
      request({
        mode: "url",
        message: "Authorize",
        elicitationId: "auth-1",
        url: "https://example.com/authorize",
      }),
    );

    expect(result).toEqual({ action: "cancel" });
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("no browser"), "error");
  });

  it("supports every primitive form field, defaults, and omission", async () => {
    const { handleElicitationRequest } = await import("../../elicitation-handler.ts");
    const ui = createElicitationUi(
      [
        "Continue",
        "Use default",
        "Medium (medium)",
        "No",
        "Enter value",
        "Choose values",
        "Red",
        "Done",
        "Omit",
        "Submit",
      ],
      ["42"],
    );

    const result = await handleElicitationRequest(
      { serverName: "demo", ui, allowUrl: true },
      request({
        mode: "form",
        message: "Configure the operation",
        requestedSchema: {
          type: "object",
          properties: {
            title: { type: "string", default: "Untitled" },
            priority: {
              type: "string",
              oneOf: [
                { const: "low", title: "Low" },
                { const: "medium", title: "Medium" },
              ],
            },
            enabled: { type: "boolean" },
            count: { type: "integer", minimum: 1, maximum: 100 },
            colors: {
              type: "array",
              items: { type: "string", enum: ["Red", "Blue"] },
              minItems: 1,
            },
            note: { type: "string" },
          },
          required: ["priority", "enabled", "count", "colors"],
        },
      }),
    );

    expect(result).toEqual({
      action: "accept",
      content: {
        title: "Untitled",
        priority: "medium",
        enabled: false,
        count: 42,
        colors: ["Red"],
      },
    });
  });
});
