import { expect, test } from '@playwright/test';

test('Settings summaries open editors in dialogs and Cancel discards drafts and restores focus', async ({ page }) => {
  await page.goto('/settings/repositories');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  const repository = page.getByRole('row', { name: /^pages(\s|$)/ });
  const open = repository.getByRole('button', { name: 'Open', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Edit Repository: pages' });
  await expect(
    dialog.locator('.settings-dialog-footer').getByRole('button', { name: 'Save Repository' }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
  await dialog.getByLabel('Name', { exact: true }).fill('discarded');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(open).toBeFocused();
  await open.click();
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('pages');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test('Repository validation stays in its modal without losing input and saves update the summary', async ({ page }) => {
  await page.goto('/settings/repositories');
  await page
    .getByRole('row', { name: /^pages(\s|$)/ })
    .getByRole('button', { name: 'Open', exact: true })
    .click();
  const existing = page.getByRole('dialog', { name: 'Edit Repository: pages' });
  const folder = await existing.getByLabel('Local folder').inputValue();
  await existing.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Add Repository', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Repository', exact: true });
  await dialog.getByLabel('Name', { exact: true }).fill('modal-test');
  await dialog.getByLabel('Local folder').fill('/missing/modal-test');
  await dialog.getByLabel('GitLab connection').selectOption('corp');
  await dialog.getByRole('button', { name: 'Add Repository', exact: true }).click();
  await expect(dialog.locator('.error-box')).toBeVisible();
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('modal-test');
  await expect(dialog.getByLabel('GitLab connection')).toHaveValue('corp');
  await dialog.getByLabel('Local folder').fill(folder);
  await dialog.getByRole('button', { name: 'Add Repository', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const created = page.getByRole('row', { name: /^modal-test(\s|$)/ });
  await expect(created).toBeVisible();
  await created.getByRole('button', { name: 'Delete Repository', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete Repository', exact: true }).click();
  await expect(created).toHaveCount(0);
});

test('Agents and Workflow settings use modal editors while direct Agent links still work', async ({ page }) => {
  await page.goto('/settings/agents');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'New Agent', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'New Agent', exact: true });
  await create.getByLabel('Name', { exact: true }).fill(' ');
  await create.getByLabel('Instructions', { exact: true }).fill('Preserve the preview interaction.');
  await create.getByRole('button', { name: 'Create Agent', exact: true }).click();
  await expect(create.locator('.error-box')).toBeVisible();
  await expect(create.getByLabel('Instructions', { exact: true })).toHaveValue('Preserve the preview interaction.');
  await create.getByLabel('Name', { exact: true }).fill('Modal agent');
  let releaseSave: () => void = () => {};
  const heldSave = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route('**/settings/agents', async (route) => {
    if (route.request().method() === 'POST') await heldSave;
    await route.continue();
  });
  await create.getByRole('button', { name: 'Create Agent', exact: true }).click();
  try {
    await expect(create.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(create).toBeVisible();
  } finally {
    releaseSave();
  }
  await expect(create).not.toBeVisible();
  await page.unroute('**/settings/agents');
  const agent = page.getByRole('row', { name: /^Modal agent(\s|$)/ });
  await agent.getByRole('button', { name: 'Open', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Agent: Modal agent' });
  await expect(edit.locator('.settings-dialog-footer').getByRole('button', { name: 'Save Agent' })).toBeVisible();
  await expect(edit.locator('form').getByRole('link', { name: 'Open full page' })).toBeVisible();
  await expect(edit.getByLabel('Instructions', { exact: true })).toHaveValue('Preserve the preview interaction.');
  await edit.getByLabel('Instructions', { exact: true }).fill('Updated modal instructions.');
  await edit.getByRole('button', { name: 'Save Agent', exact: true }).click();
  await expect(edit).not.toBeVisible();
  await agent.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(edit.getByLabel('Instructions', { exact: true })).toHaveValue('Updated modal instructions.');
  await edit.getByRole('link', { name: 'Open full page' }).click();
  await expect(page).toHaveURL(/\/settings\/agents\/\d+$/);
  await expect(page.getByLabel('Instructions', { exact: true })).toBeVisible();
  await page.goto('/settings/agents');
  await page
    .getByRole('row', { name: /^MR Automation(\s|$)/ })
    .getByRole('button', { name: 'Open', exact: true })
    .click();
  const workflow = page.getByRole('dialog', { name: 'MR Automation settings' });
  await expect(
    workflow.locator('.settings-dialog-footer').getByRole('button', { name: 'Save template' }),
  ).toBeVisible();
  await expect(workflow.getByLabel('Default Agent')).toBeVisible();
  await expect(workflow.getByLabel('Operation template')).toBeVisible();
  await workflow.getByRole('button', { name: 'Save template', exact: true }).click();
  await expect(workflow).not.toBeVisible();
  await agent.getByRole('button', { name: 'Delete Agent', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete Agent', exact: true }).click();
  await expect(agent).toHaveCount(0);
});

test('Configuration editor is modal, shows save errors and fits a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings/config');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open configuration', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Configuration', exact: true });
  await expect(dialog.getByLabel('Provider', { exact: true })).toBeVisible();
  const model = await dialog.locator('#config-runs-defaultModel').inputValue();
  await dialog.locator('#config-runs-defaultModel').fill('');
  await dialog.getByRole('button', { name: 'Save Configuration' }).click();
  await expect(dialog.locator('.error-box')).toBeVisible();
  await expect(dialog.locator('#config-runs-defaultModel')).toHaveValue('');
  const box = await dialog.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(390);
  expect(box?.height).toBeLessThanOrEqual(844);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open configuration', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Open configuration', exact: true }).click();
  await expect(dialog.locator('#config-runs-defaultModel')).toHaveValue(model);
  await expect(dialog.locator('.error-box')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save Configuration', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test('Settings dialogs fit desktop, tablet and phone viewports', async ({ page }) => {
  const editors = [
    { path: '/settings/projects', trigger: 'New project', title: 'New Project' },
    { path: '/settings/repositories', trigger: 'Add Repository', title: 'Add Repository' },
    { path: '/settings/agents', trigger: 'New Agent', title: 'New Agent' },
    { path: '/settings/config', trigger: 'Open configuration', title: 'Edit Configuration' },
  ];
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const editor of editors) {
      await page.goto(editor.path);
      await page.getByRole('button', { name: editor.trigger, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: editor.title, exact: true });
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
      const footer = dialog.locator('.settings-dialog-footer');
      await expect(footer.locator('button[type="submit"]')).toHaveCount(1);
      const submit = await footer.locator('button[type="submit"]').boundingBox();
      const cancel = await footer.getByRole('button', { name: 'Cancel', exact: true }).boundingBox();
      expect(submit).not.toBeNull();
      expect(cancel).not.toBeNull();
      expect(Math.abs(submit!.y - cancel!.y)).toBeLessThan(2);
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).not.toBeVisible();
    }
  }
});

test('Configuration aligns checkbox labels and pairs Schedule fields', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings/config');
  await page.getByRole('button', { name: 'Open configuration', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const enabled = dialog.getByLabel('Enabled', { exact: true });
  await enabled.scrollIntoViewIfNeeded();
  const geometry = await enabled.evaluate((input) => {
    const box = input.getBoundingClientRect();
    const label = input.closest('label')!;
    const text = document.createRange();
    text.selectNodeContents(label.lastChild!);
    const textBox = text.getBoundingClientRect();
    return {
      gap: textBox.left - box.right,
      centerDifference: Math.abs((box.top + box.bottom - textBox.top - textBox.bottom) / 2),
    };
  });
  expect(geometry.gap).toBeGreaterThanOrEqual(0);
  expect(geometry.gap).toBeLessThan(16);
  expect(geometry.centerDifference).toBeLessThan(4);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [first, second] of [
      ['mr', 'default'],
      ['start', 'end'],
    ]) {
      const group = first === 'mr' ? 'intervals' : 'workingHours';
      const left = dialog.locator(`#config-schedule-${group}-${first}`);
      const right = dialog.locator(`#config-schedule-${group}-${second}`);
      await left.scrollIntoViewIfNeeded();
      const a = await left.boundingBox();
      const b = await right.boundingBox();
      if (width > 640) {
        expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
        expect(b!.x).toBeGreaterThan(a!.x + a!.width);
      } else {
        expect(Math.abs(a!.x - b!.x)).toBeLessThan(2);
        expect(b!.y).toBeGreaterThan(a!.y + a!.height);
      }
    }
  }
});

test('Settings entity lists are zebra tables with a lighter first row and non-heading entity names', async ({
  page,
}) => {
  await page.goto('/settings/agents');
  const rows = page.getByRole('table', { name: 'Agents' }).locator('tbody tr');
  const [first, second] = await Promise.all(
    [0, 1].map((i) => rows.nth(i).evaluate((row) => getComputedStyle(row).backgroundColor)),
  );
  const lightness = (rgb: string) =>
    rgb
      .match(/\d+/g)!
      .slice(0, 3)
      .reduce((sum, v) => sum + Number(v), 0);
  expect(lightness(first)).toBeGreaterThan(lightness(second));
  await expect(page.getByRole('heading', { level: 2, name: 'Agents', exact: true })).toBeVisible();
  await expect(rows.first().getByRole('heading')).toHaveCount(0);
});

test('Days field keeps a new blank line so the next number can be typed, saved and reloaded', async ({ page }) => {
  await page.goto('/settings/config');
  await page.getByRole('button', { name: 'Open configuration', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const days = dialog.locator('#config-schedule-workingHours-days');
  const original = await days.inputValue();
  const lines = original.split('\n');
  const next = String(Math.max(...lines.map(Number)) + 1 > 7 ? 0 : Math.max(...lines.map(Number)) + 1);
  const expected = `${original}\n${next}`;
  try {
    await days.focus();
    await days.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
    await page.keyboard.press('Enter');
    await expect(days).toHaveValue(`${original}\n`);
    await page.keyboard.type(next);
    await expect(days).toHaveValue(expected);
    await dialog.getByRole('button', { name: 'Save Configuration', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Open configuration', exact: true }).click();
    await expect(page.getByRole('dialog').locator('#config-schedule-workingHours-days')).toHaveValue(expected);
  } finally {
    await page.goto('/settings/config');
    await page.getByRole('button', { name: 'Open configuration', exact: true }).click();
    await page.getByRole('dialog').locator('#config-schedule-workingHours-days').fill(original);
    await page.getByRole('dialog').getByRole('button', { name: 'Save Configuration', exact: true }).click();
  }
});

test('Upgrade and restart asks for confirmation and Back leaves the application running', async ({ page }) => {
  await page.goto('/settings/config');
  await page.getByRole('button', { name: 'Upgrade and restart', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('rejected while Runs are active or queued');
  await dialog.getByRole('button', { name: 'Back' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Upgrade and restart', exact: true })).toBeVisible();
});

test('the application default and a personal color scheme are chosen in settings and applied without a reload', async ({
  page,
}) => {
  const html = page.locator('html');
  await page.goto('/settings/config');
  await expect(html).toHaveAttribute('data-scheme', 'dark');
  const defaults = page.getByRole('group', { name: 'Application default' });
  await expect(defaults.getByRole('button', { name: 'Light' }).locator('.scheme-swatch')).toHaveCount(3);
  await defaults.getByRole('button', { name: 'Light' }).click();
  await expect(html).toHaveAttribute('data-scheme', 'light');

  await page.goto('/account');
  const own = page.getByRole('group', { name: 'Your color scheme' });
  await expect(own.getByRole('button', { name: 'Use application default' })).toHaveAttribute('aria-pressed', 'true');
  await own.getByRole('button', { name: 'Dark' }).click();
  await expect(html).toHaveAttribute('data-scheme', 'dark');
  await page.reload();
  await expect(html).toHaveAttribute('data-scheme', 'dark');

  await own.getByRole('button', { name: 'Use application default' }).click();
  await expect(html).toHaveAttribute('data-scheme', 'light');

  await page.goto('/settings/config');
  await page.getByRole('group', { name: 'Application default' }).getByRole('button', { name: 'Dark' }).click();
  await expect(html).toHaveAttribute('data-scheme', 'dark');
});

test('Agent form offers collapsible additional instructions and a generate button after them', async ({ page }) => {
  await page.goto('/settings/agents');
  await page.getByRole('button', { name: 'New Agent', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New Agent', exact: true });
  const block = form.locator('details.additional-instructions');
  await expect(block).not.toHaveAttribute('open', '');
  await expect(form.getByLabel('Additional instructions')).toBeHidden();
  await block.getByText('Additional instructions', { exact: true }).click();
  await expect(form.getByLabel('Additional instructions')).toBeVisible();

  const generate = form.getByRole('button', { name: "Generate Agent's instruction" });
  expect(await generate.evaluate((button, el) => !el.contains(button), await block.elementHandle())).toBe(true);
  expect(
    await block.evaluate(
      (el, button) => Boolean(el.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING),
      await generate.elementHandle(),
    ),
  ).toBe(true);

  await generate.click();
  await expect(form.getByRole('alert')).toContainText('Enter instructions or additional instructions');
});
