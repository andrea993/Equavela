import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentInfo, EnvironmentSwitchPreview } from "../equavelaApi";
import { S } from "../strings";
import { EnvironmentManager } from "./EnvironmentManager";

afterEach(cleanup);

const info = (overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo => ({
  kind: "shared",
  directory: "/home/me/.julia/environments/v1.11",
  absolute: false,
  kernel: "shared",
  problems: [],
  files: {
    project_toml: "[deps]",
    project_exists: true,
    manifest_toml: "julia_version = \"1.11.0\"",
    manifest_exists: true,
    dependencies: [
      { name: "JSON3", uuid: "json3-id", compatibility: null, version: "1.14.0", installed: true },
    ],
    error: null,
  },
  kernel_status: { status: "ready", info: { julia: "1.11.0", package: "EquavelaKernel", protocol: 1 } },
  can_override: true,
  last_change: null,
  interrupted_change: null,
  ...overrides,
});

const preview = (overrides: Partial<EnvironmentSwitchPreview> = {}): EnvironmentSwitchPreview => ({
  token: "opaque-preview-token",
  current: { kind: "shared", directory: "/shared", absolute: false, kernel: "shared" },
  target: { kind: "override", directory: "/work/project-env", absolute: true, kernel: "override" },
  files: info().files,
  differences: [{ name: "JSON3", current: "1.14.0", target: null, missing: true }],
  ...overrides,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("Julia environment manager", () => {
  it("renders metadata as literal text and closes the viewer without changing the environment", async () => {
    const source = '<Project>\n<script>window.pwned = true</script>\n[deps]';
    const onReadEnvironmentMetadata = vi.fn().mockResolvedValue(source);
    const onPreviewEnvironment = vi.fn();
    const onCopyEnvironment = vi.fn();
    const onChangePackages = vi.fn();
    const onManageEnvironment = vi.fn();
    const onSetCompatibility = vi.fn();
    const onClose = vi.fn();
    const { container } = render(<EnvironmentManager load={vi.fn().mockResolvedValue(info())} onReadEnvironmentMetadata={onReadEnvironmentMetadata} onCommitEnvironment={vi.fn().mockResolvedValue(undefined)} onPreviewEnvironment={onPreviewEnvironment} onCopyEnvironment={onCopyEnvironment} onChangePackages={onChangePackages} onManageEnvironment={onManageEnvironment} onSetCompatibility={onSetCompatibility} onClose={onClose} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.viewProject }));
    await waitFor(() => expect(container.querySelector(".environment-metadata pre")?.textContent).toBe(source));
    const contents = container.querySelector(".environment-metadata pre")!;
    expect(contents.tagName).toBe("PRE");
    expect(contents.textContent).toBe(source);
    expect(contents.querySelector("script, project")).toBeNull();
    expect(onReadEnvironmentMetadata).toHaveBeenCalledWith("project");
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.closeMetadata }));
    expect(container.querySelector(".environment-metadata pre")).toBeNull();
    expect(within(dialog).getByTestId("environment-kind").textContent).toBe(S.environment.kinds.shared);
    expect(onPreviewEnvironment).not.toHaveBeenCalled();
    expect(onCopyEnvironment).not.toHaveBeenCalled();
    expect(onChangePackages).not.toHaveBeenCalled();
    expect(onManageEnvironment).not.toHaveBeenCalled();
    expect(onSetCompatibility).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows errors from reading metadata in the inline viewer", async () => {
    const onReadEnvironmentMetadata = vi.fn().mockRejectedValue(new Error("cannot read Manifest.toml"));
    render(<EnvironmentManager load={vi.fn().mockResolvedValue(info())} onReadEnvironmentMetadata={onReadEnvironmentMetadata} onCommitEnvironment={vi.fn().mockResolvedValue(undefined)} onPreviewEnvironment={vi.fn()} onCopyEnvironment={vi.fn()} onChangePackages={vi.fn()} onManageEnvironment={vi.fn()} onSetCompatibility={vi.fn()} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.viewManifest }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("cannot read Manifest.toml");
    expect(within(dialog).getByRole("heading", { name: S.environment.manifestMetadata })).toBeTruthy();
  });

  it("closes previously loaded metadata when a successful switch reloads changed environment info", async () => {
    const current = info({ kind: "override", directory: "/work/override", absolute: true });
    const shared = info();
    const load = vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(shared);
    const plan = preview({
      current: { kind: "override", directory: current.directory, absolute: true, kernel: current.kernel },
      target: { kind: "shared", directory: shared.directory, absolute: false, kernel: shared.kernel },
    });
    render(<EnvironmentManager load={load} onReadEnvironmentMetadata={vi.fn().mockResolvedValue("old override metadata")} onCommitEnvironment={vi.fn().mockResolvedValue(undefined)} onPreviewEnvironment={vi.fn().mockResolvedValue(plan)} onCopyEnvironment={vi.fn()} onChangePackages={vi.fn()} onManageEnvironment={vi.fn()} onSetCompatibility={vi.fn()} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.viewProject }));
    await waitFor(() => expect(dialog.querySelector(".environment-metadata pre")?.textContent).toBe("old override metadata"));
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.useShared }));
    const confirmation = await within(dialog).findByRole("alertdialog", { name: S.environment.switchPreview });
    fireEvent.click(within(confirmation).getByRole("button", { name: S.environment.switchAndRecalculate }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(dialog.querySelector(".environment-metadata pre")).toBeNull());
    expect(within(dialog).getByTestId("environment-kind").textContent).toBe(S.environment.kinds.shared);
  });

  it("shows the requested bound separately and lets the row editor be cancelled", async () => {
    const loaded = info({ files: { ...info().files, dependencies: [{ ...info().files.dependencies[0], compatibility: "~1.14" }] } });
    render(<EnvironmentManager load={vi.fn().mockResolvedValue(loaded)} onReadEnvironmentMetadata={vi.fn().mockResolvedValue("")} onCommitEnvironment={vi.fn().mockResolvedValue(undefined)} onPreviewEnvironment={vi.fn()} onCopyEnvironment={vi.fn()} onChangePackages={vi.fn()} onManageEnvironment={vi.fn()} onSetCompatibility={vi.fn().mockResolvedValue(loaded)} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    expect(within(dialog).getByText(S.environment.packageCompatibility)).toBeTruthy();
    expect(within(dialog).getByText(S.environment.installedVersion)).toBeTruthy();
    expect(within(dialog).getByText("~1.14")).toBeTruthy();
    expect(within(dialog).getByText("1.14.0")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: `${S.environment.editCompatibility} JSON3` }));
    expect((within(dialog).getByRole("textbox", { name: `${S.environment.compatibilityBound} JSON3` }) as HTMLInputElement).value).toBe("~1.14");
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.cancel }));
    expect(within(dialog).queryByRole("textbox", { name: `${S.environment.compatibilityBound} JSON3` })).toBeNull();
  });

  it("confirms a compatibility edit for the named package and keeps the editor open on errors", async () => {
    const loaded = info();
    const onSetCompatibility = vi.fn().mockRejectedValue(new Error("incompatible version bound"));
    render(<EnvironmentManager load={vi.fn().mockResolvedValue(loaded)} onReadEnvironmentMetadata={vi.fn().mockResolvedValue("")} onCommitEnvironment={vi.fn().mockResolvedValue(undefined)} onPreviewEnvironment={vi.fn()} onCopyEnvironment={vi.fn()} onChangePackages={vi.fn()} onManageEnvironment={vi.fn()} onSetCompatibility={onSetCompatibility} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    fireEvent.click(within(dialog).getByRole("button", { name: `${S.environment.editCompatibility} JSON3` }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: `${S.environment.compatibilityBound} JSON3` }), { target: { value: "~2.0" } });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.setCompatibility }));
    const confirmation = within(dialog).getByRole("alertdialog", { name: S.environment.confirm });
    expect(confirmation.textContent).toContain("JSON3");
    expect(confirmation.textContent).toContain("~2.0");
    expect(confirmation.textContent).toContain(loaded.directory);
    fireEvent.click(within(confirmation).getByRole("button", { name: S.environment.setCompatibility }));
    expect(await within(dialog).findByText("incompatible version bound")).toBeTruthy();
    expect(onSetCompatibility).toHaveBeenCalledWith("JSON3", "~2.0");
    expect(within(dialog).getByRole("alertdialog", { name: S.environment.confirm })).toBeTruthy();
    expect(within(dialog).getByRole("textbox", { name: `${S.environment.compatibilityBound} JSON3` })).toBeTruthy();
  });

  it("uses an empty bound to clear compatibility after explicit confirmation", async () => {
    const loaded = info({ files: { ...info().files, dependencies: [{ ...info().files.dependencies[0], compatibility: "~1.14" }] } });
    const cleared = info();
    const onSetCompatibility = vi.fn().mockResolvedValue(cleared);
    render(<EnvironmentManager load={vi.fn().mockResolvedValue(loaded)} onReadEnvironmentMetadata={vi.fn().mockResolvedValue("")} onCommitEnvironment={vi.fn().mockResolvedValue(undefined)} onPreviewEnvironment={vi.fn()} onCopyEnvironment={vi.fn()} onChangePackages={vi.fn()} onManageEnvironment={vi.fn()} onSetCompatibility={onSetCompatibility} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    fireEvent.click(within(dialog).getByRole("button", { name: `${S.environment.editCompatibility} JSON3` }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: `${S.environment.compatibilityBound} JSON3` }), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.setCompatibility }));
    const confirmation = within(dialog).getByRole("alertdialog", { name: S.environment.confirm });
    expect(confirmation.textContent).toContain("Clear JSON3 compatibility");
    fireEvent.click(within(confirmation).getByRole("button", { name: S.environment.setCompatibility }));
    await waitFor(() => expect(onSetCompatibility).toHaveBeenCalledWith("JSON3", ""));
    await waitFor(() => expect(within(dialog).queryByRole("textbox", { name: `${S.environment.compatibilityBound} JSON3` })).toBeNull());
  });

  it("requires confirmation before adding packages and does nothing when cancelled", async () => {
    const load = vi.fn().mockResolvedValue(info());
    const onChangePackages = vi.fn();
    render(<EnvironmentManager load={load} onReadEnvironmentMetadata={vi.fn().mockResolvedValue("")} onCommitEnvironment={vi.fn().mockResolvedValue(undefined)} onPreviewEnvironment={vi.fn().mockResolvedValue(undefined)} onCopyEnvironment={vi.fn().mockResolvedValue(undefined)} onChangePackages={onChangePackages} onManageEnvironment={vi.fn().mockResolvedValue(info())} onSetCompatibility={vi.fn().mockResolvedValue(info())} onClose={vi.fn()} />);

    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    fireEvent.change(within(dialog).getByRole("textbox", { name: S.environment.packageToAdd }), { target: { value: "DataFrames, CSV" } });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.addPackage }));

    const confirmation = within(dialog).getByRole("alertdialog", { name: S.environment.confirm });
    expect(confirmation.textContent).toContain("Add DataFrames, CSV");
    expect(confirmation.textContent).toContain("DefaultEnv for every worksheet that uses it");
    expect(confirmation.textContent).toContain("downloads the package from the network");
    expect(onChangePackages).not.toHaveBeenCalled();

    fireEvent.click(within(confirmation).getByRole("button", { name: S.environment.cancel }));
    expect(within(dialog).queryByRole("alertdialog")).toBeNull();
    expect(onChangePackages).not.toHaveBeenCalled();
  });

  it("asks before removing a listed package and calls the package operation only on confirmation", async () => {
    const onChangePackages = vi.fn().mockResolvedValue(info({ files: { ...info().files, dependencies: [] } }));
    render(<EnvironmentManager load={vi.fn().mockResolvedValue(info())} onReadEnvironmentMetadata={vi.fn().mockResolvedValue("")} onCommitEnvironment={vi.fn().mockResolvedValue(undefined)} onPreviewEnvironment={vi.fn().mockResolvedValue(undefined)} onCopyEnvironment={vi.fn().mockResolvedValue(undefined)} onChangePackages={onChangePackages} onManageEnvironment={vi.fn().mockResolvedValue(info())} onSetCompatibility={vi.fn().mockResolvedValue(info())} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });

    fireEvent.click(within(dialog).getByRole("button", { name: `${S.environment.remove} JSON3` }));
    const confirmation = within(dialog).getByRole("alertdialog", { name: S.environment.confirm });
    expect(confirmation.textContent).toContain("Remove JSON3");
    expect(confirmation.textContent).toContain("from /home/me/.julia/environments/v1.11");
    expect(onChangePackages).not.toHaveBeenCalled();

    fireEvent.click(within(confirmation).getByRole("button", { name: S.environment.confirm }));
    await waitFor(() => expect(onChangePackages).toHaveBeenCalledWith(["JSON3"], true));
  });

  it("keeps the dialog open and marks it busy while a package operation is pending", async () => {
    const operation = deferred<EnvironmentInfo>();
    const onClose = vi.fn();
    const onChangePackages = vi.fn(() => operation.promise);
    render(<EnvironmentManager load={vi.fn().mockResolvedValue(info())} onReadEnvironmentMetadata={vi.fn().mockResolvedValue("")} onCommitEnvironment={vi.fn().mockResolvedValue(undefined)} onPreviewEnvironment={vi.fn().mockResolvedValue(undefined)} onCopyEnvironment={vi.fn().mockResolvedValue(undefined)} onChangePackages={onChangePackages} onManageEnvironment={vi.fn().mockResolvedValue(info())} onSetCompatibility={vi.fn().mockResolvedValue(info())} onClose={onClose} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    fireEvent.change(within(dialog).getByRole("textbox", { name: S.environment.packageToAdd }), { target: { value: "CSV" } });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.addPackage }));
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.confirm }));

    await waitFor(() => expect(within(dialog).getByRole("status").textContent).toBe(S.environment.working));
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    expect(within(dialog).getByRole("button", { name: S.environment.close }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.pointerDown(screen.getByRole("presentation"));
    expect(onClose).not.toHaveBeenCalled();

    operation.resolve(info());
    await waitFor(() => expect(dialog.getAttribute("aria-busy")).toBe("false"));
  });

  it("previews a switch, lets it be cancelled without mutation, then commits the opaque plan", async () => {
    const alternate = info({ kind: "override", directory: "/work/project-env" });
    const load = vi.fn().mockResolvedValueOnce(info()).mockResolvedValueOnce(alternate);
    const plan = preview();
    const onPreviewEnvironment = vi.fn().mockResolvedValue(plan);
    const onCommitEnvironment = vi.fn().mockResolvedValue(undefined);
    render(<EnvironmentManager load={load} onReadEnvironmentMetadata={vi.fn().mockResolvedValue("")} onPreviewEnvironment={onPreviewEnvironment} onCommitEnvironment={onCommitEnvironment} onCopyEnvironment={vi.fn().mockResolvedValue(undefined)} onChangePackages={vi.fn()} onManageEnvironment={vi.fn().mockResolvedValue(info())} onSetCompatibility={vi.fn().mockResolvedValue(info())} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });

    const update = within(dialog).getByRole("button", { name: S.environment.update }) as HTMLButtonElement;
    const remove = within(dialog).getByRole("button", { name: `${S.environment.remove} JSON3` }) as HTMLButtonElement;
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.useAnother }));
    const confirmation = await within(dialog).findByRole("alertdialog", { name: S.environment.switchPreview });
    expect(update.disabled).toBe(true);
    expect(remove.disabled).toBe(true);
    expect(within(confirmation).getByRole("button", { name: S.environment.switchAndRecalculate }).hasAttribute("disabled")).toBe(false);
    expect(confirmation.textContent).toContain("/shared");
    expect(confirmation.textContent).toContain("/work/project-env");
    expect(confirmation.textContent).toContain("JSON3");
    expect(confirmation.textContent).toContain(S.environment.switchMissingWarning);
    expect(confirmation.textContent).toContain(S.environment.switchNoInstall);
    expect(onCommitEnvironment).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: S.environment.cancel }));
    expect(update.disabled).toBe(false);
    expect(remove.disabled).toBe(false);
    expect(onCommitEnvironment).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.useAnother }));
    const secondConfirmation = await within(dialog).findByRole("alertdialog", { name: S.environment.switchPreview });
    fireEvent.click(within(secondConfirmation).getByRole("button", { name: S.environment.switchAndRecalculate }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(onPreviewEnvironment).toHaveBeenCalledWith(true);
    expect(onCommitEnvironment).toHaveBeenCalledWith("opaque-preview-token");
    expect(within(dialog).getByTestId("environment-kind").textContent).toBe(S.environment.kinds.override);
    expect(within(dialog).getByText("/work/project-env")).toBeTruthy();
  });

  it("keeps the current environment visible and asks for reload after a stale commit", async () => {
    const load = vi.fn().mockResolvedValue(info());
    const onPreviewEnvironment = vi.fn().mockResolvedValue(preview());
    const onCommitEnvironment = vi.fn().mockRejectedValue(new Error("stale environment switch"));
    render(<EnvironmentManager load={load} onReadEnvironmentMetadata={vi.fn().mockResolvedValue("")} onPreviewEnvironment={onPreviewEnvironment} onCommitEnvironment={onCommitEnvironment} onCopyEnvironment={vi.fn()} onChangePackages={vi.fn()} onManageEnvironment={vi.fn()} onSetCompatibility={vi.fn()} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.useAnother }));
    const confirmation = await within(dialog).findByRole("alertdialog", { name: S.environment.switchPreview });
    fireEvent.click(within(confirmation).getByRole("button", { name: S.environment.switchAndRecalculate }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("stale environment switch");
    expect(within(dialog).getByRole("alert").textContent).toContain(S.environment.switchReloadNeeded);
    expect(within(dialog).getByTestId("environment-kind").textContent).toBe(S.environment.kinds.shared);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("shows preview errors without changing the displayed environment", async () => {
    const load = vi.fn().mockResolvedValue(info());
    const onPreviewEnvironment = vi.fn().mockRejectedValue(new Error("target environment is unavailable"));
    render(<EnvironmentManager load={load} onReadEnvironmentMetadata={vi.fn().mockResolvedValue("")} onCommitEnvironment={vi.fn().mockResolvedValue(undefined)} onPreviewEnvironment={onPreviewEnvironment} onCopyEnvironment={vi.fn()} onChangePackages={vi.fn()} onManageEnvironment={vi.fn()} onSetCompatibility={vi.fn()} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.useAnother }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("target environment is unavailable");
    expect(within(dialog).getByTestId("environment-kind").textContent).toBe(S.environment.kinds.shared);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("confirms a metadata-only copy, lets it be cancelled, then reloads the copied override", async () => {
    const copied = info({ kind: "override", directory: "/work/copied-env" });
    const load = vi.fn().mockResolvedValueOnce(info()).mockResolvedValueOnce(copied);
    const onCopyEnvironment = vi.fn().mockResolvedValue(undefined);
    render(<EnvironmentManager load={load} onReadEnvironmentMetadata={vi.fn().mockResolvedValue("")} onCommitEnvironment={vi.fn().mockResolvedValue(undefined)} onPreviewEnvironment={vi.fn()} onCopyEnvironment={onCopyEnvironment} onChangePackages={vi.fn()} onManageEnvironment={vi.fn()} onSetCompatibility={vi.fn().mockResolvedValue(info())} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.copy }));
    const path = within(dialog).getByRole("textbox", { name: S.environment.destination });
    fireEvent.change(path, { target: { value: "/work/copied-env" } });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.copyDestination }));
    const confirmation = within(dialog).getByRole("alertdialog", { name: S.environment.confirm });
    expect(confirmation.textContent).toContain("/home/me/.julia/environments/v1.11");
    expect(confirmation.textContent).toContain("/work/copied-env");
    expect(confirmation.textContent).toContain("does not install packages");
    expect(confirmation.textContent).toContain("Undoing the worksheet selection will leave the copied files in place");
    expect(within(dialog).getByRole("button", { name: S.environment.addPackage }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(confirmation).getByRole("button", { name: S.environment.cancel }));
    expect(onCopyEnvironment).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.copyDestination }));
    const confirmation2 = within(dialog).getByRole("alertdialog", { name: S.environment.confirm });
    fireEvent.click(within(confirmation2).getByRole("button", { name: S.environment.copyAsOverride }));
    await waitFor(() => expect(onCopyEnvironment).toHaveBeenCalledWith("/work/copied-env"));
    await waitFor(() => expect(within(dialog).getByTestId("environment-kind").textContent).toBe(S.environment.kinds.override));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps the manager open and shows copy failures", async () => {
    const load = vi.fn().mockResolvedValue(info());
    const onCopyEnvironment = vi.fn().mockRejectedValue(new Error("Destination already exists"));
    render(<EnvironmentManager load={load} onReadEnvironmentMetadata={vi.fn().mockResolvedValue("")} onCommitEnvironment={vi.fn().mockResolvedValue(undefined)} onPreviewEnvironment={vi.fn()} onCopyEnvironment={onCopyEnvironment} onChangePackages={vi.fn()} onManageEnvironment={vi.fn()} onSetCompatibility={vi.fn().mockResolvedValue(info())} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.copy }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: S.environment.destination }), { target: { value: "/work/already-there" } });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.copyDestination }));
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.copyAsOverride }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Destination already exists");
    expect(load).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole("button", { name: S.environment.close })).toBeTruthy();
  });

  it("does not offer copy for environments that cannot be overridden", async () => {
    render(<EnvironmentManager load={vi.fn().mockResolvedValue(info({ can_override: false }))} onReadEnvironmentMetadata={vi.fn().mockResolvedValue("")} onCommitEnvironment={vi.fn().mockResolvedValue(undefined)} onPreviewEnvironment={vi.fn()} onCopyEnvironment={vi.fn()} onChangePackages={vi.fn()} onManageEnvironment={vi.fn()} onSetCompatibility={vi.fn().mockResolvedValue(info())} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    expect(within(dialog).queryByRole("button", { name: S.environment.copy })).toBeNull();
  });

  it.each(["instantiate", "resolve", "update"] as const)("confirms or cancels %s for the named environment", async (operation) => {
    const onManageEnvironment = vi.fn().mockResolvedValue(info());
    const onChangePackages = vi.fn();
    const renderManager = () => render(<EnvironmentManager
      load={vi.fn().mockResolvedValue(info({ files: { ...info().files, manifest_exists: operation !== "instantiate" } }))}
      onReadEnvironmentMetadata={vi.fn().mockResolvedValue("")} onCommitEnvironment={vi.fn().mockResolvedValue(undefined)} onPreviewEnvironment={vi.fn().mockResolvedValue(undefined)}
      onCopyEnvironment={vi.fn().mockResolvedValue(undefined)}
      onChangePackages={onChangePackages}
      onManageEnvironment={onManageEnvironment}
      onSetCompatibility={vi.fn().mockResolvedValue(info())}
      onClose={vi.fn()}
    />);

    const first = renderManager();
    let dialog = await screen.findByRole("dialog", { name: S.environment.title });
    const trigger = within(dialog).getByRole("button", { name: S.environment[operation] }) as HTMLButtonElement;
    fireEvent.click(trigger);
    let confirmation = within(dialog).getByRole("alertdialog", { name: S.environment.confirm });
    expect(trigger.disabled).toBe(true);
    expect(within(confirmation).getByRole("button", { name: S.environment.confirm }).hasAttribute("disabled")).toBe(false);
    expect(confirmation.textContent).toContain("/home/me/.julia/environments/v1.11");
    if (operation === "instantiate") expect(confirmation.textContent).toContain("dependencies recorded in the manifest");
    if (operation === "instantiate") expect(confirmation.textContent).toContain(S.environment.instantiateWithoutManifest);
    expect(confirmation.textContent).toContain("every worksheet");
    if (operation === "resolve") expect(confirmation.textContent).toContain("reconcile dependencies");
    if (operation === "update") expect(confirmation.textContent).toContain("versions can change");
    expect(onManageEnvironment).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: S.environment.addPackage }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(confirmation).getByRole("button", { name: S.environment.cancel }));
    expect(trigger.disabled).toBe(false);
    expect(onManageEnvironment).not.toHaveBeenCalled();
    first.unmount();

    renderManager();
    dialog = await screen.findByRole("dialog", { name: S.environment.title });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment[operation] }));
    confirmation = within(dialog).getByRole("alertdialog", { name: S.environment.confirm });
    fireEvent.click(within(confirmation).getByRole("button", { name: S.environment.confirm }));
    await waitFor(() => expect(onManageEnvironment).toHaveBeenCalledWith(operation));
    expect(onChangePackages).not.toHaveBeenCalled();
  });

  it("undoes the last package change after a confirmation naming it", async () => {
    const change = { operation: "add", packages: ["Plots"], started: 1 };
    const onRevertChange = vi.fn().mockResolvedValue(info());
    render(<EnvironmentManager load={vi.fn().mockResolvedValue(info({ last_change: change }))} onReadEnvironmentMetadata={vi.fn()} onCommitEnvironment={vi.fn()} onPreviewEnvironment={vi.fn()} onCopyEnvironment={vi.fn()} onChangePackages={vi.fn()} onManageEnvironment={vi.fn()} onSetCompatibility={vi.fn()} onRevertChange={onRevertChange} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.undoLastChange("Add Plots") }));
    const confirm = within(dialog).getByRole("alertdialog", { name: S.environment.confirm });
    expect(confirm.textContent).toContain('Undo "Add Plots"');
    expect(confirm.textContent).toContain("DefaultEnv for every worksheet that uses it");
    expect(onRevertChange).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: S.environment.confirm }));
    await waitFor(() => expect(onRevertChange).toHaveBeenCalledWith(false, true));
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: /Undo last package change/ })).toBeNull());
  });

  it("offers to restore or keep an interrupted change and hides undo meanwhile", async () => {
    const change = { operation: "update", packages: [], started: 1 };
    const onRevertChange = vi.fn().mockResolvedValue(info());
    render(<EnvironmentManager load={vi.fn().mockResolvedValue(info({ interrupted_change: change, last_change: change }))} onReadEnvironmentMetadata={vi.fn()} onCommitEnvironment={vi.fn()} onPreviewEnvironment={vi.fn()} onCopyEnvironment={vi.fn()} onChangePackages={vi.fn()} onManageEnvironment={vi.fn()} onSetCompatibility={vi.fn()} onRevertChange={onRevertChange} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    const notice = within(dialog).getByRole("alertdialog", { name: S.environment.restorePrevious });
    expect(notice.textContent).toContain("(Update) was interrupted");
    expect(within(dialog).queryByRole("button", { name: /Undo last package change/ })).toBeNull();
    fireEvent.click(within(notice).getByRole("button", { name: S.environment.keepCurrent }));
    await waitFor(() => expect(onRevertChange).toHaveBeenCalledWith(true, false));
    await waitFor(() => expect(within(dialog).queryByRole("alertdialog", { name: S.environment.restorePrevious })).toBeNull());
  });

  it("restarts the kernel after a confirmation naming who shares it", async () => {
    const onRestartKernel = vi.fn().mockResolvedValue(info());
    render(<EnvironmentManager load={vi.fn().mockResolvedValue(info())} onReadEnvironmentMetadata={vi.fn()} onCommitEnvironment={vi.fn()} onPreviewEnvironment={vi.fn()} onCopyEnvironment={vi.fn()} onChangePackages={vi.fn()} onManageEnvironment={vi.fn()} onSetCompatibility={vi.fn()} onRestartKernel={onRestartKernel} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog", { name: S.environment.title });
    fireEvent.click(within(dialog).getByRole("button", { name: S.environment.restartKernel }));
    const confirm = within(dialog).getByRole("alertdialog", { name: S.environment.confirm });
    expect(confirm.textContent).toContain("Every worksheet using DefaultEnv");
    expect(onRestartKernel).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: S.environment.confirm }));
    await waitFor(() => expect(onRestartKernel).toHaveBeenCalledTimes(1));
  });
});
