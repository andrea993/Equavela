// Loaded only by the opt-in e2e-project build, into the worksheet
// webview: drives New Project, Open Project and the navigator with real DOM events and posts the result.
(async () => {
  if (window.__equavelaProjectTestStarted) return;
  window.__equavelaProjectTestStarted = true;
  const endpoint = __ENDPOINT__;
  const options = __OPTIONS__;
  const checks = [];
  const post = (path, body) => fetch(endpoint + path, { method: 'POST', body: JSON.stringify(body) });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (label, find, ms = 60000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = await find();
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
      await wait(50);
    }
  };
  const check = (label, ok, detail) => {
    checks.push({ label, ok: !!ok, detail });
    // The driver prints each check as it happens, so a hang shows where it stopped.
    post('/progress', label).catch(() => {});
    if (!ok) throw new Error(`${label}${detail === undefined ? '' : `: ${detail}`}`);
  };
  // React reads the value through the native setter, so plain assignment would be lost.
  const type = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const labelled = (root, text) => [...root.querySelectorAll('label')].find((l) => l.textContent.startsWith(text))?.querySelector('input');
  const dialog = (title) => [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('h2')?.textContent === title);
  const navigator = () => document.querySelector('nav[aria-label="Project explorer"]');
  // a tree row by its project-relative path, and its folders opened on the way.
  const treeRow = (path) => navigator()?.querySelector(`[role="treeitem"][data-path="${path}"]`);
  const reveal = async (path) => {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      // Click until it is open: the explorer may open top folders itself meanwhile.
      const path = parts.slice(0, i).join('/');
      let clicked = 0;
      await until(`folder ${path}`, () => {
        const folder = treeRow(path);
        if (!folder) return null;
        if (folder.getAttribute('aria-expanded') === 'true') return folder;
        if (Date.now() - clicked > 300) { folder.click(); clicked = Date.now(); }
        return null;
      });
    }
    return until(`row ${path}`, () => treeRow(path));
  };
  const key = (target, name) => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  const nameField = () => until('name field', () => navigator().querySelector('input[aria-label="Name"]'));
  const tabs = () => [...document.querySelectorAll('[role="tablist"][aria-label="Open worksheets"] [role="tab"]')];
  const mainPath = `${options.root}/worksheets/main.eqv`;
  const nativeDrop = async (target, paths) => {
    target.scrollIntoView({ block: 'nearest' });
    const box = target.getBoundingClientRect();
    await window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', {
      target: { kind: 'Webview', label: 'main' }, event: 'tauri://drag-drop',
      payload: { paths, position: { x: Math.round((box.left + box.width / 2) * devicePixelRatio), y: Math.round((box.top + box.height / 2) * devicePixelRatio) } },
    });
  };

  const command = async (text) => {
    (await until('ribbon search', () => document.querySelector('.ribbon-search'))).click();
    const search = await until('command search', () => document.querySelector('input[aria-label="Search commands"]'));
    type(search, text);
    await wait(100);
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  const submit = async (title, fields) => {
    const form = await until(`${title} dialog`, () => dialog(title));
    for (const [label, value] of fields) type(await until(label, () => labelled(form, label)), value);
    form.querySelector('button[type="submit"]').click();
    return form;
  };
  const refused = async (title, fields, expected) => {
    const form = await submit(title, fields);
    const alert = await until(`${title} alert`, () => form.querySelector('[role="alert"]'));
    check(`${title} shows "${expected}" and stays open`, alert.textContent.includes(expected) && dialog(title), alert.textContent);
    return form;
  };
  const cancel = async (form) => {
    [...form.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    await until('dialog closed', () => !document.querySelector('[role="dialog"]'));
  };

  // Showcase: open a ready project, show its tree and worksheets, and ask the driver for
  // screenshots (`/shot`) instead of running the checks.
  if (options.showcase) {
    // Marks that only matter while editing (for example the crosshair), hidden from the pictures.
    if (options.showcase.hide) document.head.append(Object.assign(document.createElement('style'), { textContent: `${options.showcase.hide} { visibility: hidden !important; }` }));
    try {
      await until('the app', () => window.__equavela && document.querySelector('.ribbon-search'), 300000);
      await window.__equavela.openProjectAt(options.showcase.root);
      for (const path of options.showcase.expand) await reveal(path);
      for (const shot of options.showcase.shots) {
        if (shot.open) (await reveal(shot.open)).click();
        // A button to press first, by its accessible name (for example the compact ribbon toggle).
        if (shot.press) (await until(shot.press, () => document.querySelector(`button[aria-label="${shot.press}"]`))).click();
        if (shot.problems) {
          document.querySelector('[data-testid="panel-toggle"]')?.click();
          (await until('problems tab', () => document.querySelector('[data-testid="panel-tab-problems"]'))).click();
        }
        if (shot.log) await post('/progress', [...document.querySelectorAll(shot.log)].map((e) => e.textContent).join(' | '));
        // A result that never comes still gets its picture, which then shows why.
        if (shot.wait) await until(shot.wait, () => document.querySelector(shot.wait) && /\d/.test(document.querySelector(shot.wait).textContent), 90000).catch(() => {});
        // After the results, which change the page's height.
        if (shot.scroll) (await until(shot.scroll, () => document.querySelector(shot.scroll), 60000)).scrollIntoView({ block: shot.block ?? 'center' });
        await wait(shot.settle ?? 1500);
        await post('/shot', { name: shot.name });
      }
      await post('', { ok: true, checks });
    } catch (error) {
      await post('', { ok: false, checks, error: `${error && error.message ? error.message : error}` });
    }
    return;
  }

  try {
    await until('the app', () => window.__equavela && document.querySelector('.ribbon-search'), 300000);
    await post('/progress', { stage: 'ready' });

    // a relative destination is refused, then the project is created.
    await command('new project');
    await refused('New project', [['Project name', options.name], ['New project directory', 'relative/project']], 'absolute');
    await submit('New project', [['New project directory', options.root]]);
    await until('New project dialog closed', () => !dialog('New project'));
    check('the project files and its julia environment folder exist', (await (await post('/disk', { root: options.root })).json()).ok);
    const nav = await until('navigator', navigator);
    check('the navigator names the project', nav.querySelector('.tree-title')?.textContent === options.name, nav.querySelector('.tree-title')?.textContent);
    // creating opens no worksheet and none is marked main; a click opens it.
    const entry = await reveal('worksheets/main.eqv');
    check('no worksheet is marked main and none opened by itself', !entry.querySelector('.tree-badge') && !tabs().some((t) => t.dataset.path === mainPath), entry.textContent);
    entry.click();
    await until('main entry current', () => entry.getAttribute('aria-current') === 'page');
    check('the clicked worksheet is the active tab', tabs().some((t) => t.dataset.path === mainPath && t.getAttribute('aria-selected') === 'true'));
    await nativeDrop(await reveal('worksheets'), [options.nativeCsv]);
    await reveal('worksheets/drop-samples.csv');
    check('native file drop copies into its hovered project folder without moving the source', (await (await post('/drop-copy', { image: false })).json()).ok);
    // the new project's worksheet uses the project environment.
    const indicator = await until('environment indicator', () => document.querySelector('[data-testid="environment-indicator"]'));
    check('the status bar shows the project environment', indicator.textContent === 'Julia: project' && indicator.title.endsWith('/julia'), `${indicator.textContent} ${indicator.title}`);

    // an existing destination, a missing project and a declared environment are refused.
    await command('new project');
    await cancel(await refused('New project', [['Project name', 'Again'], ['New project directory', options.root]], 'exist'));
    // Open project is the native folder picker (not drivable here); the folder it returns opens
    // through the same path, and a refusal goes to the message bar.
    const messageBar = () => document.querySelector('.message-bar')?.textContent ?? '';
    await window.__equavela.openProjectAt(options.missing);
    await until('missing project message', () => messageBar().includes('Could not open the project'));
    check('a missing project reports an error', true);
    // long paths must not push fields or error text outside the modal.
    await command('new project');
    let open = await refused('New project', [['Project name', 'Long'], ['New project directory', `relative/${'LongProjectName'.repeat(40)}`]], 'absolute');
    for (const width of ['', '280px']) {
      open.style.width = width;
      await new Promise(requestAnimationFrame);
      const alert = open.querySelector('[role="alert"]');
      check(`project error and directory stay inside the ${width || 'normal'} dialog`,
        open.scrollWidth <= open.clientWidth + 1 && alert.scrollWidth <= alert.clientWidth + 1);
    }
    open.style.width = '';
    await cancel(open);
    await post('/environment', { root: options.root, copy: options.environmentRoot });
    await window.__equavela.openProjectAt(options.environmentRoot);
    await until('environment refusal message', () => messageBar().includes('julia'));
    check('a project whose environment is not a folder is refused', true);

    // reopening activates the existing tab.
    const before = tabs().length;
    await window.__equavela.openProjectAt(options.root);
    check('reopening keeps one tab', tabs().length === before, `${before} -> ${tabs().length}`);

    // the navigator survives closing every tab and reopens the worksheet from disk.
    const closeAll = async () => {
      for (const tab of tabs()) {
        tab.parentElement.querySelector('button[aria-label^="Close"]').click();
        await wait(300);
        const discard = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((b) => b.textContent === "Don't save");
        discard?.click();
      }
      await until('every tab closed', () => tabs().length === 0);
    };
    const reopen = async () => {
      (await reveal('worksheets/main.eqv')).click();
      await until('reopened from the navigator', () => tabs().some((t) => t.dataset.path === mainPath));
    };
    // the driver puts an asset and a region that shows it on disk.
    await post('/asset', { root: options.root });
    await closeAll();
    check('the navigator stays with no tab', navigator());
    await reopen();
    check('the navigator reopens the worksheet', true);
    await until('asset image drawn', () => document.querySelector('[data-testid="image"] img[src^="data:image/png;base64,"]'));
    check('a project asset image is drawn from the project folder', true);
    const asset = await reveal('assets/images/beam.png');
    check('the navigator lists the asset', asset.textContent.includes('beam.png'), asset.textContent);
    await nativeDrop(asset, [options.nativePng]);
    await reveal('assets/images/drop-picture.png');
    check('native image drop over a file imports beside it', (await (await post('/drop-copy', { image: true })).json()).ok);
    check('explorer image drop does not insert a worksheet region', document.querySelectorAll('[data-testid="image"]').length === 1);
    await command('Image resource usage');
    const imageUsage = await until('image usage', () => dialog('Image resource usage'));
    await until('resource owners', () => imageUsage.textContent.includes('assets/images/beam.png') && imageUsage.textContent.includes('worksheets/main.eqv'));
    check('image usage names its worksheet owner', imageUsage.querySelectorAll('.project-image-owner').length === 1);
    [...imageUsage.querySelectorAll('button')].find(button => button.textContent === 'Close').click();
    // : renaming a used image rewrites its owners' references in one operation.
    const renameAsset = (path, name) => window.__TAURI_INTERNALS__.invoke('project_rename', { root: options.root, path, name })
      .then(() => '', error => String(error?.message ?? error));
    const mainText = async () => (await window.__TAURI_INTERNALS__.invoke('project_read_text', { root: options.root, path: 'worksheets/main.eqv' })).text;
    const assetRenameError = await renameAsset('assets/images/beam.png', 'renamed.png');
    const renamedText = assetRenameError ? '' : await mainText();
    check('renaming a referenced image rewrites its owner', !assetRenameError && renamedText.includes('assets/images/renamed.png') && !renamedText.includes('assets/images/beam.png'), assetRenameError);
    await until('renamed image drawn', () => document.querySelector('[data-testid="image"] img[src^="data:image/png;base64,"]'));
    check('the owner tab still draws the renamed image', tabs().some(tab => tab.dataset.path === mainPath));
    const restoreError = await renameAsset('assets/images/renamed.png', 'beam.png');
    check('renaming the image back restores its reference', !restoreError && (await mainText()).includes('assets/images/beam.png'), restoreError);
    const assetDeletionError = await window.__TAURI_INTERNALS__.invoke('project_delete', { root: options.root, path: 'assets/images/beam.png' })
      .then(() => '', error => String(error?.message ?? error));
    check('a referenced asset cannot be deleted', assetDeletionError.includes('assets/images/beam.png') && assetDeletionError.includes('worksheets/main.eqv'));
    check('refused asset deletion leaves its worksheet tab open', tabs().some(tab => tab.dataset.path === mainPath));

    // a missing asset does not stop the load; the region shows the broken frame.
    await post('/asset-remove', { root: options.root });
    await closeAll();
    await reopen();
    await until('broken frame', () => document.querySelector('[data-testid="image"].failed'));
    check('a missing asset opens with a broken frame', true);
    await until('missing resource badge', () => treeRow('worksheets/main.eqv')?.querySelector('.tree-resource-count'));
    check('the worksheet row marks its unavailable image resource', treeRow('worksheets/main.eqv').querySelector('.tree-resource-count').textContent.includes('1'));
    await command('Image resource usage');
    const unavailableUsage = await until('unavailable image usage', () => dialog('Image resource usage'));
    await until('missing resource status', () => unavailableUsage.textContent.includes('assets/images/beam.png') && unavailableUsage.textContent.includes('Unavailable'));
    check('image usage reports referenced missing files', unavailableUsage.querySelector('.project-image-owner').textContent === 'worksheets/main.eqv');
    unavailableUsage.querySelector('.project-image-owner').click();
    await until('owner worksheet opened', () => !dialog('Image resource usage'));

    //  through the real commands (the dialogs give these paths).
    const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
    const refusal = async (promise) => {
      try {
        await promise;
        return '';
      } catch (error) {
        return String(error && error.message ? error.message : error);
      }
    };
    const missingAsset = await refusal(invoke('pack_project_archive', { root: options.root, destination: options.archive }));
    check('packing refuses a project with a missing asset and names it', missingAsset.includes('beam.png'), missingAsset);
    await post('/asset', { root: options.root });
    const packed = await invoke('pack_project_archive', { root: options.root, destination: options.archive });
    check('the project is packed to the chosen .eqvz', packed === options.archive, packed);
    const again = await refusal(invoke('pack_project_archive', { root: options.root, destination: options.archive }));
    check('an existing archive is never replaced', again.includes('already exists'), again);
    const extracted = await invoke('extract_project_archive', { source: options.archive, destination: options.extracted });
    check('the archive extracts into the new folder', typeof extracted === 'string' && extracted.endsWith('extracted project'), extracted);
    check('the extracted files are on disk and nothing is left behind', (await (await post('/archive', { root: options.extracted })).json()).ok);
    const occupied = await refusal(invoke('extract_project_archive', { source: options.archive, destination: options.extracted }));
    check('extraction never replaces an existing folder', occupied.includes('already exists'), occupied);
    await window.__equavela.openProjectAt(extracted);
    await until('extracted project in the navigator', () => navigator()?.querySelector(`[role="treeitem"][title="${extracted}/worksheets/main.eqv"]`));
    // the extracted project opens with no worksheet; its worksheet opens from the explorer.
    navigator().querySelector(`[role="treeitem"][title="${extracted}/worksheets/main.eqv"]`).click();
    await until('extracted asset image drawn', () => tabs().some((t) => t.dataset.path === `${extracted}/worksheets/main.eqv` && t.getAttribute('aria-selected') === 'true')
      && document.querySelector('[data-testid="image"] img[src^="data:image/png;base64,"]'));
    check('the extracted project opens and draws its asset', true);

    // Save As a portable document, then open it from the UI.
    await post('/standalone', {});
    const standalone = await invoke('open_worksheet', { path: options.standalone });
    check('the standalone worksheet uses its own environment', standalone.environment.kind === 'override', standalone.environment.kind);
    const saved = await invoke('save_worksheet_as', { worksheet: standalone.id, path: options.portable });
    check('Save As .eqvz reopens the worksheet as a portable document', saved && saved.opened && saved.opened.environment.kind === 'archive', JSON.stringify(saved && saved.opened && saved.opened.environment));
    const portable = await (await post('/portable', { directory: saved.opened.environment.directory })).json();
    check('the .eqvz holds the worksheet and its environment, materialized for the document', portable.ok, portable.detail);
    await invoke('close_worksheet', { worksheet: saved.opened.id });
    check('Open accepts the .eqvz', await window.__equavela.openPath(options.portable));
    await until('portable tab active', () => tabs().some((t) => t.dataset.path === options.portable && t.getAttribute('aria-selected') === 'true'));
    await until('document environment shown', () => document.querySelector('[data-testid="environment-indicator"]')?.textContent === 'Julia: document');
    check('the status bar shows the document environment', true);

    // the opened portable document becomes a project, from the command palette.
    await command('convert to project');
    const convert = await until('Convert to project dialog', () => dialog('Convert to project'));
    check('Convert to project suggests the worksheet name', labelled(convert, 'Project name').value === 'sizing è', labelled(convert, 'Project name').value);
    await submit('Convert to project', [['New project directory', options.converted]]);
    await until('Convert to project dialog closed', () => !dialog('Convert to project'));
    const convertedSheet = `${options.converted}/worksheets/sizing è.eqv`;
    await until('converted worksheet in the navigator', () => navigator()?.querySelector(`[role="treeitem"][title="${convertedSheet}"]`));
    await until('converted tab active', () => tabs().some((t) => t.dataset.path === convertedSheet && t.getAttribute('aria-selected') === 'true'));
    check('the converted project opens in the tab of the document', !tabs().some((t) => t.dataset.path === options.portable));
    check('the converted project carries the document environment', (await (await post('/converted', {})).json()).ok);

    // a worksheet made, renamed and sent to the trash from the tree, checked on disk.
    const folder = await reveal('worksheets');
    folder.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 200 }));
    [...(await until('tree menu', () => document.querySelector('.tree-menu'))).querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'New worksheet…').click();
    let field = await nameField();
    type(field, 'Checks');
    key(field, 'Enter');
    await until('new worksheet tab', () => tabs().some((t) => t.dataset.path === `${options.converted}/worksheets/Checks.eqv`));
    const checks1 = await reveal('worksheets/Checks.eqv');
    checks1.focus();
    key(checks1, 'F2');
    field = await nameField();
    type(field, 'Checks v2.eqv');
    key(field, 'Enter');
    await until('renamed tab', () => tabs().some((t) => t.dataset.path === `${options.converted}/worksheets/Checks v2.eqv`));
    check('a new worksheet is created and renamed in the tree', (await (await post('/worksheets', { removed: false })).json()).ok);
    await command('Project settings');
    const settings = await until('project settings', () => dialog('Project settings'));
    check('project settings offer no main worksheet', !settings.querySelector('select'));
    [...settings.querySelectorAll('button')].find(button => button.textContent === 'Apply').click();
    await until('settings closed', () => !dialog('Project settings'));
    const checks2 = await reveal('worksheets/Checks v2.eqv');
    checks2.focus();
    key(checks2, 'Delete');
    const confirmTrash = await until('trash confirmation', () => document.querySelector('[role="alertdialog"][aria-label="Move to trash"]'));
    [...confirmTrash.querySelectorAll('button')].find((b) => b.textContent === 'Move to trash').click();
    await until('row gone', () => !treeRow('worksheets/Checks v2.eqv'));
    check('deleting moves the worksheet to the trash and closes its tab', (await (await post('/worksheets', { removed: true })).json()).ok
      && !tabs().some((t) => t.dataset.path === `${options.converted}/worksheets/Checks v2.eqv`));

    // a Julia file made in the tree, opened in a text tab, edited and saved.
    const julia = await reveal('julia');
    julia.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 200 }));
    [...(await until('tree menu', () => document.querySelector('.tree-menu'))).querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'New Julia file…').click();
    field = await nameField();
    type(field, 'tools');
    key(field, 'Enter');
    (await reveal('julia/tools.jl')).click();
    const editor = await until('text tab', () => document.querySelector('textarea[aria-label="julia/tools.jl"]'));
    check('a Julia file opens in a text tab', editor.value.includes('using'), editor.value);
    await until('file title', () => document.title.includes('julia/tools.jl'));
    check('a file tab supplies the title and hides the worksheet inspector', !document.querySelector('.side-panel')
      && treeRow('julia/tools.jl').getAttribute('aria-current') === 'page');
    await command('Insert Julia block');
    check('worksheet commands keep the file tab in front', document.querySelector('textarea[aria-label="julia/tools.jl"]') === editor);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, 'area(b, h) = b * h\n');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await until('modified tree indicator', () => treeRow('julia/tools.jl').querySelector('.tree-dirty'));
    check('an edited file marks the title and project tree', document.title.includes('tools.jl *'));
    // wait for the normal autosave timer and inspect its real app-data sidecar.
    const backupDeadline = Date.now() + 65000;
    for (;;) {
      if ((await (await post('/text-backup', {})).json()).ok) break;
      if (Date.now() > backupDeadline) throw new Error('text autosave did not preserve the buffer separately from its source');
      await wait(250);
    }
    check('text autosave writes app-data recovery without changing the source', true);
    check('the test project moves away from its original location', (await (await post('/recovery-project-move', { restore: false })).json()).ok);
    await command('Recovered text files');
    const recoveryBrowser = await until('recovery browser', () => dialog('Recovered text files'));
    const recoveredEntry = await until('source-independent backup entry', () => [...recoveryBrowser.querySelectorAll('button')].find(button => button.textContent.includes('julia/tools.jl')));
    recoveredEntry.click();
    await until('recovered text preview', () => recoveryBrowser.querySelector('pre')?.textContent === 'area(b, h) = b * h\n');
    check('recovered text remains readable when its original project is missing', recoveryBrowser.textContent.includes(options.converted));
    [...recoveryBrowser.querySelectorAll('button')].find(button => button.textContent === 'Close').click();
    check('the test project returns before normal saving', (await (await post('/recovery-project-move', { restore: true })).json()).ok);
    await reveal('julia/tools.jl');
    check('the driver damages only the test recovery copy', (await (await post('/corrupt-text-backup', {})).json()).ok);
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await until('saved tab', () => ![...document.querySelectorAll('[role="tab"]')].some((t) => (t.dataset.path ?? '').endsWith('/julia/tools.jl') && t.textContent.includes('*')));
    check('Ctrl+S writes the text tab to disk', (await (await post('/julia-file', {})).json()).ok);
    const cleanupDeadline = Date.now() + 10000;
    for (;;) {
      if ((await (await post('/text-backup', {})).json()).quarantined) break;
      if (Date.now() > cleanupDeadline) throw new Error('saved text recovery was not quarantined');
      await wait(100);
    }
    check('saving clears the file modification indicator', !treeRow('julia/tools.jl').querySelector('.tree-dirty'));
    check('saving removes the obsolete text recovery sidecar', !(await (await post('/text-backup', {})).json()).present);
    check('saving preserves malformed recovery bytes in quarantine', (await (await post('/text-backup', {})).json()).quarantined);
    await command('Project settings');
    const fileSettings = await until('settings from text tab', () => dialog('Project settings'));
    [...fileSettings.querySelectorAll('button')].find(button => button.textContent === 'Manage Julia environment…').click();
    const environmentManager = await until('project environment manager', () => document.querySelector('.environment-manager'));
    await until('project environment info', () => environmentManager.textContent.includes('Project environment'));
    check('project settings target the project environment from a text tab', environmentManager.textContent.includes(options.converted + '/julia'));
    [...environmentManager.querySelectorAll('button')].find(button => button.textContent === 'Close').click();
    // Project settings is still open and modal; the explorer behind it takes no keys.
    await until('environment manager closed', () => !document.querySelector('.environment-manager'));
    const settingsLeft = dialog('Project settings');
    if (settingsLeft) {
      settingsLeft.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await until('project settings closed', () => !dialog('Project settings'));
    }

    // use the actual WebKit layout, including a native window resize when requested.
    const frame = document.querySelector('.project-explorer-frame');
    const separator = frame.querySelector('[role="separator"]');
    key(separator, 'End');
    await until('resized explorer', () => Math.abs(frame.getBoundingClientRect().width - 420) < 2);
    check('the explorer separator resizes the actual panel', separator.getAttribute('aria-valuenow') === '420');
    key(separator, 'Home');
    frame.querySelector('[aria-label="Collapse project explorer"]').click();
    await until('collapsed explorer rail', () => frame.getBoundingClientRect().width === 36);
    frame.querySelector('[aria-label="Expand project explorer"]').click();
    await until('expanded explorer', () => frame.getBoundingClientRect().width === 160);
    check('collapse and reopen retain the explorer folders', treeRow('julia/tools.jl') !== null);
    if (options.layout) {
      tabs().find(t => t.dataset.path.startsWith(options.converted + '/') && t.dataset.path.endsWith('.eqv')).click();
      check('the driver resizes the native window', (await (await post('/resize', { width: 700, height: 800 })).json()).ok);
      await until('narrow window', () => innerWidth === 700 && frame.dataset.narrow === 'true');
      const toggle = document.querySelector('[data-testid="panel-toggle"]');
      if (toggle.getAttribute('aria-pressed') !== 'true') toggle.click();
      await until('inspector drawer', () => document.querySelector('.side-panel') && frame.dataset.open === 'false');
      check('the narrow inspector overlays a usable worksheet', document.querySelector('.sheet-host').getBoundingClientRect().width >= 650);
      const expand = frame.querySelector('[aria-label="Expand project explorer"]');
      const rect = expand.getBoundingClientRect();
      check('the explorer reopen button remains reachable beside the inspector', expand.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)));
      expand.click();
      await until('explorer drawer', () => frame.dataset.open === 'true' && !document.querySelector('.side-panel'));
      check('opening the explorer closes the narrow inspector', document.querySelector('.sheet-host').getBoundingClientRect().width >= 650);
      frame.querySelector('.project-explorer-backdrop').click();
      await until('drawer closed', () => frame.dataset.open === 'false');
      check('the explorer backdrop closes its drawer', true);
      await post('/resize', { width: 1280, height: 800 });
    }

    // the specification : a referenced project's export evaluates
    // under its alias; its private names stay out of reach.
    check('the driver writes a provider project that exports c_p', (await (await post('/reference-provider', {})).json()).ok);
    const addedReference = await invoke('project_add_reference', { root: options.converted, folder: options.provider, alias: null });
    check('adding a reference locks the provider exports', addedReference?.manifest.references?.[0]?.alias === 'Thermo'
      && addedReference.manifest.references[0].api.length === 1, JSON.stringify(addedReference?.manifest.references));
    const referencesSection = () => navigator()?.querySelector('section[aria-label="References"]');
    (await until('references section', () => referencesSection()?.querySelector('button[aria-label="Reload references"]'))).click();
    const thermoRow = await until('reference row', () => referencesSection()?.querySelector('[data-reference="Thermo"]'));
    check('the explorer lists the reference', thermoRow.textContent.includes('Thermo'));
    thermoRow.click();
    await until('reference exports', () => referencesSection().textContent.includes('Thermo.c_p(·)'));
    check('the reference shows its exports under the alias', true);
    check('the driver writes a worksheet that uses the reference', (await (await post('/reference-consumer', {})).json()).ok);
    check('the consumer worksheet opens', await window.__equavela.openPath(`${options.converted}/worksheets/uses.eqv`));
    await until('consumer worksheet', () => tabs().some(t => t.dataset.path.endsWith('/worksheets/uses.eqv')));
    const regionText = (id) => document.querySelector(`[data-region-id="${id}"]`)?.textContent ?? '';
    await wait(15000);
    check('a referenced export evaluates in the consumer', regionText('use').includes('600'),
      JSON.stringify({ use: regionText('use'), mine: regionText('mine'), own: regionText('own'), html: document.querySelector('[data-region-id="use"]')?.outerHTML.slice(0, 600), problems: document.querySelector('[aria-label="Problems"]')?.textContent?.slice(0, 400) }));
    await until('own result', () => regionText('mine').includes('5'));
    check("the consumer's own k is not the provider's private k", !regionText('mine').includes('2'), regionText('mine'));
    const privateRegion = await until('private name error', () => {
      const region = document.querySelector('[data-region-id="private"]');
      return region && region.outerHTML.includes('exports no') ? region : null;
    });
    check('a private name of the reference is reported as not exported', privateRegion !== null);

    // a real terminal replaces the textarea evaluator. This injected driver
    // verifies the bridge; e2e-repl.mjs sends actual GUI keyboard input as well.
    (await until('REPL toggle', () => document.querySelector('[data-testid="repl-toggle"]'))).click();
    await until('terminal frontend', () => document.querySelector('.terminal-host .xterm-screen'));
    const terminalBytes = async () => {
      const snapshot = await invoke('terminal_read', { project: options.converted, after: 0 });
      return new TextDecoder().decode(new Uint8Array(snapshot.data));
    };
    await until('Julia prompt', async () => (await terminalBytes()).includes('julia>'), 180000);
    await invoke('terminal_write', { project: options.converted, data: 'repl_k = 1 + 2; println("PROJECT_" * "TERMINAL=", repl_k)\r' });
    await until('terminal result', async () => (await terminalBytes()).includes('PROJECT_TERMINAL=3'), 60000);
    check('the terminal evaluates in the project kernel', true);
    await invoke('terminal_write', { project: options.converted, data: 'println("PROJECT_" * "PERSIST=", repl_k * 2)\r' });
    await until('persistent terminal value', async () => (await terminalBytes()).includes('PROJECT_PERSIST=6'), 60000);
    check('terminal definitions persist in the same kernel', true);
    document.querySelector('[data-testid="repl-toggle"]').click();
    await until('REPL hidden', () => !document.querySelector('.repl-panel'));
    check('the REPL toggle hides the panel', true);

    // Insert table opens a matrix-like table at its first name; keys type into it.
    await command('Insert table');
    const tableRegion = await until('table being edited', () => document.querySelector('.region.editing .matrix.table')?.closest('[data-region-id]'));
    check('a new table opens in the math editor with its optional units row', tableRegion.querySelectorAll('.matrix.table .cell').length === 8 && !tableRegion.querySelector('input, button.table-action'));
    const press = (name, code) => window.dispatchEvent(new KeyboardEvent('keydown', { key: name, code, bubbles: true, cancelable: true }));
    for (const [name, code] of [['q', 'KeyQ'], ['Tab', 'Tab'], ['Tab', 'Tab'], ['Tab', 'Tab'], ['Tab', 'Tab'], ['4', 'Digit4'], ['Tab', 'Tab'], ['Tab', 'Tab'], ['5', 'Digit5'], ['Escape', 'Escape']]) {
      press(name, code);
      await wait(80);
    }
    await until('table committed', () => !tableRegion.classList.contains('editing'));
    const cells = [...tableRegion.querySelectorAll('.matrix.table .cell')].map((cell) => cell.textContent.trim());
    check('the table keeps its name and values and drops the empty units row', cells.length === 6 && cells[0] === 'q' && cells[2] === '4' && cells[4] === '5', JSON.stringify(cells));
    await command('Save worksheet');
    await until('table worksheet saved', () => !tabs().some((t) => t.getAttribute('aria-selected') === 'true' && t.textContent.includes('*')));
    await command('Close project');
    await wait(2000);
    const pending = document.querySelector('[role="alertdialog"], [role="dialog"]');
    check('Close project asks nothing for unmodified worksheets', !pending,
      JSON.stringify({ prompt: pending?.textContent?.slice(0, 300), tabs: tabs().map(t => t.textContent) }));
    await until('project closed', () => !document.querySelector('.project-explorer-frame'));
    check('Close project removes its explorer and tabs', !tabs().some(t => t.dataset.path.startsWith(options.converted + '/')));

    await post('', { ok: true, checks });
  } catch (error) {
    await post('', { ok: false, checks, error: `${error && error.message ? error.message : error}\n${(error && error.stack) || ''}` });
  }
})();
