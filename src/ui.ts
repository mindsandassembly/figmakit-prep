import {
  initStandardsUI,
  handleStandardsUIMessage,
  onStandardsSelectionChange,
  onStandardsDocumentChanged,
} from './ui-standards';

// --- State ---
let currentFeatureData: any = null;
let currentTokenFormat: string = 'css';
let tokenFormatted: Record<string, string> = {};

// --- DOM Helpers ---
function qs(sel: string): HTMLElement { return document.querySelector(sel) as HTMLElement; }
function qsa(sel: string): NodeListOf<Element> { return document.querySelectorAll(sel); }

function post(msg: any) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

function setStatus(text: string) {
  qs('#status-text').textContent = text;
}

// --- Tab Switching ---
qsa('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    qsa('.tab').forEach(t => t.classList.remove('active'));
    qsa('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const panelId = `panel-${(tab as HTMLElement).dataset.tab}`;
    qs('#' + panelId)?.classList.add('active');
  });
});

// --- Token format tabs ---
qsa('.token-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    qsa('.token-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTokenFormat = (tab as HTMLElement).dataset.format ?? 'css';
    if (tokenFormatted[currentTokenFormat]) {
      qs('#token-output').textContent = tokenFormatted[currentTokenFormat];
    }
  });
});

// --- Confidence badge ---
function confBadge(confidence: number): string {
  const cls = confidence >= 90 ? 'conf-high' : confidence >= 50 ? 'conf-mid' : 'conf-low';
  return `<span class="result-confidence ${cls}">${confidence}%</span>`;
}

// --- View toggle handler (shared for clean + rename) ---
document.addEventListener('click', function(e) {
  var target = e.target as HTMLElement;
  if (!target.parentElement) return;
  var parentId = target.parentElement.id;

  if (parentId === 'rename-view-toggle') {
    var view = target.dataset.view;
    qsa('#rename-view-toggle button').forEach(function(b) { b.classList.remove('active'); });
    target.classList.add('active');
    qs('#rename-results').style.display = view === 'tree' ? 'none' : 'block';
    qs('#rename-tree').style.display = view === 'tree' ? 'block' : 'none';
  }

  if (parentId === 'token-view-toggle') {
    var tokenView = target.dataset.view;
    qsa('#token-view-toggle button').forEach(function(b) { b.classList.remove('active'); });
    target.classList.add('active');
    qs('#token-inventory').style.display = tokenView === 'inventory' ? 'block' : 'none';
    qs('#token-code-view').style.display = tokenView === 'code' ? 'block' : 'none';
  }

  if (parentId === 'clean-view-toggle') {
    var cleanView = target.dataset.view;
    qsa('#clean-view-toggle button').forEach(function(b) { b.classList.remove('active'); });
    target.classList.add('active');
    qs('#clean-results').style.display = cleanView === 'tree' ? 'none' : 'block';
    qs('#clean-tree').style.display = cleanView === 'tree' ? 'block' : 'none';
  }
});

// --- Clean Panel ---
qs('#clean-scan').addEventListener('click', () => {
  setStatus('Scanning...');
  post({ type: 'scan', feature: 'cleaner' });
});

qs('#clean-apply').addEventListener('click', function() {
  if (!currentFeatureData) return;
  var checked = Array.from(qsa('#clean-results input[type="checkbox"]:checked'));
  var actions = checked.map(function(cb: any) {
    var idx = parseInt(cb.dataset.index);
    var item = currentFeatureData.all[idx];
    return { nodeId: item.id, action: item.canRemove ? 'remove' : 'flatten' };
  });
  post({ type: 'apply', feature: 'cleaner', actions: actions });
  setStatus('Cleaning...');
});

// --- Rename Panel ---
qs('#rename-scan').addEventListener('click', () => {
  setStatus('Scanning...');
  post({ type: 'scan', feature: 'renamer' });
});

qs('#rename-apply').addEventListener('click', function() {
  if (!currentFeatureData) return;
  var checked = Array.from(qsa('#rename-results input[type="checkbox"]:checked'));
  var actions = checked.map(function(cb: any) {
    var idx = parseInt(cb.dataset.index);
    var item = currentFeatureData[idx];
    return { nodeId: item.nodeId, suggestedName: item.suggestedName };
  });
  post({ type: 'apply', feature: 'renamer', actions: actions });
  setStatus('Renaming...');
});

// --- Copy Tree as Text ---
document.addEventListener('click', function(e) {
  var target = e.target as HTMLElement;
  if (!target.classList.contains('copy-tree-btn')) return;
  var source = target.dataset.source;
  var treeData: any[] = [];
  if (source === 'rename' && renameTreeData.length > 0) {
    // Apply renames before building text
    treeData = buildCleanedTree(applyRenamesToTree(renameTreeData));
  } else if (source === 'clean') {
    // Use the stored clean tree data
    var cleanTreeEl = qs('#clean-tree');
    // We need the raw tree data — store it globally
    if ((window as any)._cleanTreeData) {
      treeData = buildCleanedTree((window as any)._cleanTreeData);
    }
  }
  var text = treeToPlainText(treeData, 0);
  if (text) {
    try {
      navigator.clipboard.writeText(text);
      target.textContent = 'Copied!';
      setTimeout(function() { target.textContent = 'Copy Tree'; }, 1500);
    } catch (err) {
      // fallback
    }
  }
});

function treeToPlainText(nodes: any[], depth: number): string {
  var lines: string[] = [];
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var indent = '';
    for (var d = 0; d < depth; d++) indent += '  ';
    var name = node.displayName || node.name || '';
    var role = node.role || '';
    var line = indent + name;
    if (role && role !== name && role !== 'unknown' && role !== 'container') {
      line += ' (' + role + ')';
    }
    lines.push(line);
    if (node.children && node.children.length > 0) {
      lines.push(treeToPlainText(node.children, depth + 1));
    }
  }
  return lines.join('\n');
}

function applyRenamesToTree(nodes: any[]): any[] {
  var out: any[] = [];
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    out.push({
      name: n.name,
      displayName: n.suggestedName || n.name,
      role: n.suggestedName || n.role,
      canRemove: n.canRemove,
      canFlatten: n.canFlatten,
      children: n.children ? applyRenamesToTree(n.children) : [],
    });
  }
  return out;
}

// --- Validate Panel ---
qs('#validate-scan').addEventListener('click', () => {
  setStatus('Validating...');
  post({ type: 'scan', feature: 'validator' });
});

qs('#structure-scan').addEventListener('click', function() {
  setStatus('Analyzing structure...');
  post({ type: 'scan', feature: 'structure' });
});

qs('#text-content-scan').addEventListener('click', function() {
  setStatus('Extracting text content...');
  post({ type: 'scan', feature: 'text-content' });
});

// --- Label Panel ---
qs('#label-apply').addEventListener('click', () => {
  const role = (qs('#label-role') as HTMLSelectElement).value;
  if (!role) return;
  const mode = (document.querySelector('input[name="label-mode"]:checked') as HTMLInputElement)?.value ?? 'prefix';
  post({ type: 'apply', feature: 'labeler', role, mode });
  setStatus('Labeling...');
});

qs('#label-remove').addEventListener('click', () => {
  post({ type: 'apply', feature: 'labeler', role: '', mode: 'prefix', remove: true });
  setStatus('Removing labels...');
});

// --- BEM Panel ---
qs('#bem-scan').addEventListener('click', () => {
  setStatus('Scanning BEM...');
  post({ type: 'scan', feature: 'bem' });
});

qs('#bem-apply').addEventListener('click', () => {
  var includeModifiers = (qs('#bem-modifiers') as HTMLInputElement).checked;
  post({ type: 'apply', feature: 'bem', includeModifiers: includeModifiers });
  setStatus('Applying BEM...');
});

qs('#variant-scan').addEventListener('click', function() {
  setStatus('Scanning variants...');
  post({ type: 'scan', feature: 'variants' });
});

// --- Assets Export All ---
qs('#assets-export-all').addEventListener('click', function() {
  var checks = qsa('#assets-results .asset-export-check');
  var assets: any[] = [];
  checks.forEach(function(cb: any) {
    if (!cb.checked) return;
    var nodeId = cb.dataset.nodeId;
    var formatSelect = qs('#assets-results .asset-format-select[data-node-id="' + nodeId + '"]') as HTMLSelectElement;
    var scaleSelect = qs('#assets-results .asset-scale-select[data-node-id="' + nodeId + '"]') as HTMLSelectElement;
    var renameInput = qs('#assets-results .asset-rename input[data-node-id="' + nodeId + '"]') as HTMLInputElement;
    assets.push({
      nodeId: nodeId,
      name: renameInput ? renameInput.value : nodeId,
      format: formatSelect ? formatSelect.value : 'PNG',
      scale: scaleSelect ? parseInt(scaleSelect.value) : 1,
    });
  });
  if (assets.length > 0) {
    qs('#export-progress').style.display = 'block';
    qs('#export-progress-text').textContent = 'Exporting 0/' + assets.length + '...';
    post({ type: 'apply', feature: 'export-all', assets: assets });
    setStatus('Exporting ' + assets.length + ' assets...');
  }
});

// --- Assets Mark Exportable ---
qs('#assets-export').addEventListener('click', function() {
  var checks = qsa('#assets-results .asset-export-check');
  var exports: any[] = [];
  checks.forEach(function(cb: any) {
    if (!cb.checked) return;
    var nodeId = cb.dataset.nodeId;
    // Find the format and scale selects for this node
    var formatSelect = qs('#assets-results .asset-format-select[data-node-id="' + nodeId + '"]') as HTMLSelectElement;
    var scaleSelect = qs('#assets-results .asset-scale-select[data-node-id="' + nodeId + '"]') as HTMLSelectElement;
    var format = formatSelect ? formatSelect.value : 'PNG';
    var scale = scaleSelect ? parseInt(scaleSelect.value) : 1;
    exports.push({ nodeId: nodeId, format: format, scale: scale });
  });
  if (exports.length > 0) {
    post({ type: 'apply', feature: 'export-settings', exports: exports });
    setStatus('Marking ' + exports.length + ' assets as exportable...');
  }
});

// --- Token Generate SCSS ---
qs('#token-generate').addEventListener('click', function() {
  var lines: string[] = [];
  lines.push('// ===========================================');
  lines.push('// Design Tokens — Generated by FigmaKit Prep');
  lines.push('// ===========================================');
  lines.push('');

  // Collect color names from inputs
  var colorInputs = qsa('#token-results .token-item');
  var currentSection = '';

  colorInputs.forEach(function(item: any) {
    // Check previous sibling section header
    var prev = item.previousElementSibling;
    while (prev && !prev.classList.contains('token-section-header')) {
      prev = prev.previousElementSibling;
    }
    if (prev) {
      var sectionName = prev.textContent.trim().split(' ')[0];
      if (sectionName !== currentSection) {
        currentSection = sectionName;
        lines.push('');
        lines.push('// --- ' + currentSection + ' ---');
      }
    }

    var input = item.querySelector('.token-name-input');
    if (!input) return;
    var tokenName = (input as HTMLInputElement).value.trim();
    if (!tokenName) return;

    // Get value from the item
    var valueEl = item.querySelector('.token-value');
    var strongEl = item.querySelector('strong');
    var swatchEl = item.querySelector('.token-swatch');

    if (swatchEl) {
      // Color token
      var colorValue = '';
      if (valueEl) colorValue = valueEl.textContent.trim();
      if (colorValue) {
        lines.push('$' + tokenName + ': ' + colorValue + ';');
      }
    } else if (strongEl) {
      // Text style or spacing
      var numValue = strongEl.textContent.trim();
      if (numValue.indexOf('px') >= 0) {
        // Check if it's a text style (has font weight info)
        var detailText = item.querySelector('.token-detail');
        if (detailText && detailText.textContent.indexOf('/') >= 0) {
          // Text style: "16px / 400 — Inter"
          var parts = detailText.textContent.trim().split('/');
          var fontSize = numValue;
          var weightPart = parts[1] ? parts[1].trim().split('—')[0].trim() : '';
          var familyPart = parts[1] && parts[1].indexOf('—') >= 0 ? parts[1].split('—')[1].trim() : '';
          lines.push('$' + tokenName + '-size: ' + fontSize + ';');
          if (weightPart) lines.push('$' + tokenName + '-weight: ' + weightPart + ';');
          if (familyPart) lines.push('$' + tokenName + '-family: ' + familyPart + ';');
        } else {
          // Spacing
          lines.push('$' + tokenName + ': ' + numValue + ';');
        }
      }
    } else {
      // Font family
      var familyName = '';
      var familyEl = item.querySelector('.token-detail div');
      if (familyEl) familyName = familyEl.textContent.trim();
      if (familyName) {
        lines.push("$font-" + tokenName + ": '" + familyName + "', sans-serif;");
      }
    }
  });

  // Also add spacing scale map
  lines.push('');
  lines.push('// --- Spacing Scale ---');
  lines.push('$spacing: (');
  var scaleEntries = [
    ["'4xs'", '4px'], ["'3xs'", '8px'], ["'2xs'", '12px'],
    ["'xs'", '16px'], ["'sm'", '20px'], ["'md'", '24px'],
    ["'lg'", '32px'], ["'xl'", '48px'], ["'2xl'", '80px'], ["'3xl'", '96px'],
  ];
  for (var se = 0; se < scaleEntries.length; se++) {
    var comma = se < scaleEntries.length - 1 ? ',' : '';
    lines.push('  ' + scaleEntries[se][0] + ': ' + scaleEntries[se][1] + comma);
  }
  lines.push(');');

  var scss = lines.join('\n');

  // Switch to code view and show SCSS
  qsa('#token-view-toggle button').forEach(function(b) { b.classList.remove('active'); });
  var codeBtn = qsa('#token-view-toggle button')[1];
  if (codeBtn) codeBtn.classList.add('active');
  qs('#token-inventory').style.display = 'none';
  qs('#token-code-view').style.display = 'block';
  qs('#token-output').textContent = scss;

  // Select SCSS tab
  qsa('.token-tab').forEach(function(t) { t.classList.remove('active'); });
  var scssTab = qsa('.token-tab')[1];
  if (scssTab) scssTab.classList.add('active');
  currentTokenFormat = 'scss';
  tokenFormatted['scss-generated'] = scss;

  setStatus('SCSS generated from inventory');
});

// --- Assets Panel ---
qs('#assets-scan').addEventListener('click', function() {
  setStatus('Scanning assets...');
  post({ type: 'scan', feature: 'assets' });
});

qs('#assets-apply').addEventListener('click', function() {
  var inputs = qsa('#assets-results .asset-rename input');
  var actions: any[] = [];
  inputs.forEach(function(input: any) {
    var nodeId = input.dataset.nodeId;
    var newName = input.value.trim();
    var original = input.dataset.original;
    if (newName && newName !== original) {
      actions.push({ nodeId: nodeId, newName: newName });
    }
  });
  if (actions.length > 0) {
    post({ type: 'apply', feature: 'assets', actions: actions });
    setStatus('Renaming assets...');
  }
});

// --- Token Panel ---
qs('#token-scan').addEventListener('click', function() {
  setStatus('Extracting tokens...');
  post({ type: 'scan', feature: 'tokens' });
});

qs('#token-copy').addEventListener('click', () => {
  const text = qs('#token-output').textContent ?? '';
  navigator.clipboard?.writeText(text).then(() => {
    const btn = qs('#token-copy');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
});

// --- Render functions ---

function renderCleanResults(data: any) {
  var removable = data.removable;
  var flattenable = data.flattenable;
  var safe = data.safe;
  var tree = data.tree || [];
  currentFeatureData = { all: removable.concat(flattenable) };

  qs('#clean-summary').style.display = 'flex';
  qs('#clean-removable-count').textContent = removable.length;
  qs('#clean-flattenable-count').textContent = flattenable.length;
  qs('#clean-safe-count').textContent = safe.length;

  // Show view toggle
  qs('#clean-view-toggle').style.display = 'flex';

  var container = qs('#clean-results');
  if (removable.length === 0 && flattenable.length === 0) {
    container.innerHTML = '<div class="results-empty">No layers to clean</div>';
    (qs('#clean-apply') as HTMLButtonElement).disabled = true;
    renderCleanTree(tree);
    return;
  }

  var html = '';
  var allItems = removable.concat(flattenable);
  for (var i = 0; i < allItems.length; i++) {
    var item = allItems[i];
    var action = item.canRemove ? 'Remove' : 'Flatten';
    var actionClass = item.canRemove ? 'tree-remove' : 'tree-flatten';
    html += '<div class="result-item">' +
      '<input type="checkbox" checked data-index="' + i + '">' +
      '<span class="result-name">' + escHtml(item.name) + '</span>' +
      '<span class="result-arrow">&rarr;</span>' +
      '<span class="result-suggested ' + actionClass + '">' + action + '</span>' +
    '</div>';
  }
  container.innerHTML = html;
  (qs('#clean-apply') as HTMLButtonElement).disabled = false;

  // Render tree
  renderCleanTree(tree);
}

/**
 * Build a cleaned version of the tree:
 * - Removed nodes (canRemove) are excluded
 * - Flattened nodes (canFlatten) are replaced by their children
 * Only uses flags the analyzer already validated as safe.
 */
function buildCleanedTree(nodes: any[]): any[] {
  var result: any[] = [];
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.canRemove) {
      continue;
    }
    if (node.canFlatten && node.children && node.children.length > 0) {
      var promoted = buildCleanedTree(node.children);
      for (var j = 0; j < promoted.length; j++) {
        result.push(promoted[j]);
      }
      continue;
    }
    var cleaned: any = {
      name: node.displayName || node.name,
      displayName: node.displayName,
      role: node.role,
      canRemove: false,
      canFlatten: false,
      children: node.children ? buildCleanedTree(node.children) : [],
    };
    result.push(cleaned);
  }
  return result;
}

/**
 * Shared tree renderer — renders the final/clean version of the tree
 * into the given container element.
 */
function renderTreeInto(containerId: string, tree: any[]) {
  var treeContainer = qs(containerId);
  var cleanedTree = buildCleanedTree(tree);
  var lines: string[] = [];

  function renderNode(node: any, depth: number, prefix: string, isLast: boolean) {
    var indent = '';
    if (depth > 0) {
      indent = prefix + (isLast ? '\u2514\u2500 ' : '\u251C\u2500 ');
    }

    var displayName = node.displayName || node.name;
    var nameHtml = '<span class="tree-keep">' + escHtml(displayName) + '</span>';
    var roleHtml = node.role ? ' <span class="tree-role">(' + node.role + ')</span>' : '';

    lines.push('<span class="tree-indent">' + indent + '</span>' + nameHtml + roleHtml);

    if (node.children && node.children.length > 0) {
      var childPrefix = depth > 0 ? prefix + (isLast ? '   ' : '\u2502  ') : '';
      for (var i = 0; i < node.children.length; i++) {
        renderNode(node.children[i], depth + 1, childPrefix, i === node.children.length - 1);
      }
    }
  }

  for (var i = 0; i < cleanedTree.length; i++) {
    renderNode(cleanedTree[i], 0, '', i === cleanedTree.length - 1);
  }

  treeContainer.innerHTML = lines.map(function(l) { return '<div>' + l + '</div>'; }).join('');
}

function renderCleanTree(tree: any[]) {
  (window as any)._cleanTreeData = tree;
  renderTreeInto('#clean-tree', tree);
}

let renameTreeData: any[] = [];

function renderRenameResults(data: any) {
  var actions = data.actions;
  var tree = data.tree;
  currentFeatureData = actions;
  renameTreeData = tree || [];

  qs('#rename-summary').style.display = 'flex';
  qs('#rename-count').textContent = String(actions.length);

  // Count total layers in tree
  var totalLayers = 0;
  function countNodes(nodes: any[]) {
    for (var i = 0; i < nodes.length; i++) {
      totalLayers++;
      if (nodes[i].children) countNodes(nodes[i].children);
    }
  }
  countNodes(renameTreeData);
  qs('#rename-total').textContent = String(totalLayers);

  // Show view toggle
  qs('#rename-view-toggle').style.display = 'flex';

  var container = qs('#rename-results');
  if (actions.length === 0) {
    container.innerHTML = '<div class="results-empty">No layers to rename — all layers already have semantic names</div>';
    (qs('#rename-apply') as HTMLButtonElement).disabled = true;
    renderRenameTree(renameTreeData);
    return;
  }

  var html = '';
  actions.forEach(function(item: any, i: number) {
    html += '<div class="result-item">' +
      '<input type="checkbox" checked data-index="' + i + '">' +
      '<span class="result-name">' + escHtml(item.currentName) + '</span>' +
      '<span class="result-arrow">&rarr;</span>' +
      '<span class="result-suggested">' + escHtml(item.suggestedName) + '</span>' +
      confBadge(item.confidence) +
    '</div>';
  });
  container.innerHTML = html;
  (qs('#rename-apply') as HTMLButtonElement).disabled = false;

  // Render tree preview
  renderRenameTree(renameTreeData);
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderRenameTree(tree: any[]) {
  // Apply suggestedName as displayName before rendering
  function applyRenames(nodes: any[]): any[] {
    var out: any[] = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      out.push({
        name: n.name,
        displayName: n.suggestedName || n.name,
        role: n.suggestedName || n.role,
        canRemove: n.canRemove,
        canFlatten: n.canFlatten,
        children: n.children ? applyRenames(n.children) : [],
      });
    }
    return out;
  }
  renderTreeInto('#rename-tree', applyRenames(tree));
}

function renderValidationReport(data: any) {
  qs('#validate-empty').style.display = 'none';
  qs('#validate-report').style.display = 'block';

  function renderTier(listId: string, countId: string, items: any[]) {
    qs(countId).textContent = String(items.length);
    const container = qs(listId);
    if (items.length === 0) {
      container.innerHTML = '<div class="results-empty">None</div>';
      return;
    }
    let html = '';
    items.forEach((item: any) => {
      html += `<div class="result-item">
        <span class="result-name">${item.name}</span>
        <span class="result-arrow">&rarr;</span>
        <span class="result-suggested">${item.role}</span>
        ${confBadge(item.confidence)}
      </div>`;
    });
    container.innerHTML = html;
  }

  renderTier('#validate-high-list', '#validate-high-count', data.high);
  renderTier('#validate-mid-list', '#validate-mid-count', data.needsReview);
  renderTier('#validate-low-list', '#validate-low-count', data.low);
  renderTier('#validate-skipped-list', '#validate-skipped-count', data.skipped);
}

function renderStructureSummary(data: any) {
  qs('#validate-structure').style.display = 'block';

  // Stats bar
  var statsHtml = '';
  statsHtml += '<div class="structure-stat">Sections: <strong>' + data.totalSections + '</strong></div>';
  statsHtml += '<div class="structure-stat">Components: <strong>' + data.totalComponents + '</strong></div>';
  statsHtml += '<div class="structure-stat">Text nodes: <strong>' + data.totalTextNodes + '</strong></div>';
  statsHtml += '<div class="structure-stat">Images: <strong>' + data.totalImages + '</strong></div>';
  statsHtml += '<div class="structure-stat">Layers: <strong>' + data.layerCount + '</strong></div>';
  statsHtml += '<div class="structure-stat">Max depth: <strong>' + data.maxDepth + '</strong></div>';
  qs('#structure-stats').innerHTML = statsHtml;

  // Tree
  var lines: string[] = [];
  var entries = data.entries || [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var indent = entry.depth > 0 ? '  \u251C\u2500 ' : '';
    var name = escHtml(entry.name);
    var role = entry.role || '';
    var suffix = entry.layoutSuffix || '';
    var details: string[] = [];
    if (entry.childCount > 0) details.push(entry.childCount + ' children');
    if (entry.componentCount > 0) details.push(entry.componentCount + ' components');
    if (entry.hasImages) details.push('has images');

    var line = '<span class="tree-indent">' + indent + '</span>';
    line += '<span class="tree-keep">' + name + '</span>';
    if (role) line += ' <span class="tree-role">(' + role + suffix + ')</span>';
    if (details.length > 0) line += ' <span class="tree-indent"> \u2014 ' + details.join(', ') + '</span>';
    lines.push(line);
  }

  qs('#structure-tree').innerHTML = lines.map(function(l) { return '<div>' + l + '</div>'; }).join('');
  setStatus('Structure analysis complete');
}

function renderTextContent(data: any[]) {
  qs('#validate-text-content').style.display = 'block';
  var container = qs('#text-content-results');
  if (data.length === 0) {
    container.innerHTML = '<div class="results-empty">No text content found</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < data.length; i++) {
    var item = data[i];
    var badgeClass = item.contentType === 'heading' ? 'conf-high' :
                     item.contentType === 'button_text' ? 'conf-mid' : '';
    var label = '';
    if (item.contentType === 'heading') {
      label = 'h' + item.headingLevel;
    } else if (item.contentType === 'button_text') {
      label = 'button';
    } else {
      label = 'text';
    }

    html += '<div class="result-item">';
    html += '<span class="result-confidence ' + badgeClass + '" style="font-size:9px;min-width:45px;text-align:center">' + label + '</span>';
    html += '<span class="result-name" style="font-style:italic;color:#374151">"' + escHtml(item.content) + '"</span>';
    html += '</div>';
  }
  container.innerHTML = html;
  setStatus('Found ' + data.length + ' text items');
}

function renderVariantResults(data: any[]) {
  var container = qs('#variant-results');
  if (data.length === 0) {
    container.innerHTML = '<div class="results-empty">No component variants found</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < data.length; i++) {
    var mapping = data[i];
    html += '<div class="result-item" style="flex-direction:column;align-items:flex-start;gap:4px">';
    html += '<div style="display:flex;align-items:center;gap:6px">';
    html += '<strong>' + escHtml(mapping.nodeName) + '</strong>';
    html += '</div>';
    html += '<div style="font-size:10px;color:#6b7280">';
    for (var v = 0; v < mapping.variants.length; v++) {
      var variant = mapping.variants[v];
      html += '<span style="margin-right:8px">' + escHtml(variant.property) + ': <strong>' + escHtml(variant.value) + '</strong></span>';
    }
    html += '</div>';
    html += '<div style="font-family:monospace;font-size:10px;color:#4f46e5">';
    html += escHtml(mapping.cssClasses.join('  '));
    html += '</div>';
    html += '</div>';
  }
  container.innerHTML = html;
  setStatus('Found ' + data.length + ' variant mappings');
}

function renderBEMResults(data: any[]) {
  const container = qs('#bem-results');
  if (data.length === 0) {
    container.innerHTML = '<div class="results-empty">No BEM mappings (select a card, hero, or feature)</div>';
    (qs('#bem-apply') as HTMLButtonElement).disabled = true;
    return;
  }

  let html = '';
  data.forEach((item: any) => {
    html += `<div class="result-item">
      <span class="result-name">${item.currentName}</span>
      <span class="result-arrow">&rarr;</span>
      <span class="result-suggested">${item.bemName}</span>
    </div>`;
  });
  container.innerHTML = html;
  (qs('#bem-apply') as HTMLButtonElement).disabled = false;
}

function renderAssetResults(data: any[]) {
  qs('#assets-summary').style.display = 'flex';
  var withIssues = data.filter(function(a: any) { return !a.hasGoodName; });
  qs('#assets-total').textContent = String(data.length);
  qs('#assets-issues').textContent = String(withIssues.length);
  qs('#assets-ok').textContent = String(data.length - withIssues.length);

  var container = qs('#assets-results');
  if (data.length === 0) {
    container.innerHTML = '<div class="results-empty">No exportable assets found</div>';
    (qs('#assets-apply') as HTMLButtonElement).disabled = true;
    return;
  }

  var html = '';
  for (var i = 0; i < data.length; i++) {
    var asset = data[i];
    var typeClass = 'asset-type-' + asset.format;
    var itemClass = asset.hasGoodName ? 'asset-good' : 'asset-bad';
    var editValue = asset.suggestedName || asset.name;

    // Format dimensions (rounded)
    var w = Math.round(asset.width || 0);
    var h = Math.round(asset.height || 0);
    var sizeStr = '';
    if (w > 0 && h > 0) {
      sizeStr = w + ' &times; ' + h + 'px';
    }

    html += '<div class="asset-item ' + itemClass + '">';
    html += '<div class="asset-header">';

    // Preview thumbnail — will be filled after render
    var previewId = 'asset-preview-' + i;
    if (asset.preview && Array.isArray(asset.preview)) {
      html += '<img class="asset-preview" id="' + previewId + '" src="" alt="' + escHtml(asset.name) + '">';
    } else {
      html += '<div class="asset-preview-placeholder">' + asset.format.toUpperCase() + '</div>';
    }

    html += '<div class="asset-info">';
    html += '<div style="display:flex;align-items:center;gap:6px">';
    html += '<span class="asset-type ' + typeClass + '" data-node-id="' + asset.nodeId + '">' + asset.format.toUpperCase() + '</span>';
    html += '<span class="result-name">' + escHtml(asset.name) + '</span>';
    html += '</div>';
    if (sizeStr) {
      html += '<div class="asset-size"><span class="asset-size-value">' + sizeStr + '</span></div>';
    }
    html += '</div>'; // .asset-info
    html += '</div>'; // .asset-header

    if (asset.context) {
      html += '<div class="asset-context">' + escHtml(asset.context) + '</div>';
    }

    if (asset.issues.length > 0) {
      html += '<div class="asset-issues">';
      for (var j = 0; j < asset.issues.length; j++) {
        html += (j > 0 ? '<br>' : '') + '&#x26A0; ' + escHtml(asset.issues[j]);
      }
      html += '</div>';
    }

    if (!asset.hasGoodName) {
      html += '<div class="asset-rename">';
      html += '<span style="color:#6b7280;font-size:10px">Rename:</span>';
      html += '<input type="text" value="' + escHtml(editValue) + '" data-node-id="' + asset.nodeId + '" data-original="' + escHtml(asset.name) + '">';
      html += '</div>';
    }

    // Alt text suggestion
    if (asset.altText) {
      html += '<div class="alt-text-row">';
      html += '<span class="alt-text-label">Alt:</span>';
      html += '<input class="alt-text-input" value="' + escHtml(asset.altText) + '" data-node-id="' + asset.nodeId + '">';
      html += '</div>';
    }

    // Export controls
    var defaultFormat = asset.type === 'icon' || asset.type === 'svg' || asset.type === 'vector' ? 'SVG' : 'PNG';
    html += '<div class="asset-export-row">';
    html += '<label><input type="checkbox" class="asset-export-check" data-node-id="' + asset.nodeId + '" checked> Export</label>';
    html += '<select class="asset-format-select" data-node-id="' + asset.nodeId + '">';
    var formats = ['PNG', 'SVG', 'JPG', 'PDF'];
    for (var fi = 0; fi < formats.length; fi++) {
      var sel = formats[fi] === defaultFormat ? ' selected' : '';
      html += '<option value="' + formats[fi] + '"' + sel + '>' + formats[fi] + '</option>';
    }
    html += '</select>';
    html += '<select class="asset-scale-select" data-node-id="' + asset.nodeId + '">';
    html += '<option value="1">1x</option>';
    html += '<option value="2">2x</option>';
    html += '<option value="3">3x</option>';
    html += '</select>';
    html += '</div>';

    html += '</div>';
  }

  container.innerHTML = html;
  (qs('#assets-apply') as HTMLButtonElement).disabled = withIssues.length === 0;
  (qs('#assets-export') as HTMLButtonElement).disabled = false;
  (qs('#assets-export-all') as HTMLButtonElement).disabled = false;

  // Update format badge when dropdown changes
  qsa('#assets-results .asset-format-select').forEach(function(sel: any) {
    sel.addEventListener('change', function() {
      var nodeId = sel.dataset.nodeId;
      var badge = qs('#assets-results .asset-type[data-node-id="' + nodeId + '"]');
      if (badge) {
        var val = sel.value;
        badge.textContent = val;
        badge.className = 'asset-type asset-type-' + val.toLowerCase();
      }
    });
  });

  // Set preview images from byte arrays → blob URLs
  for (var pi = 0; pi < data.length; pi++) {
    var pAsset = data[pi];
    if (pAsset.preview && Array.isArray(pAsset.preview)) {
      var imgEl = document.getElementById('asset-preview-' + pi) as HTMLImageElement;
      if (imgEl) {
        try {
          var uint8 = new Uint8Array(pAsset.preview);
          var blob = new Blob([uint8], { type: 'image/png' });
          imgEl.src = URL.createObjectURL(blob);
        } catch (e) {
          // ignore
        }
      }
    }
  }
}

function renderTokens(data: any) {
  var agg = data.aggregated;
  tokenFormatted = data.formatted || {};

  // Show view toggle
  qs('#token-view-toggle').style.display = 'flex';

  // Render code view
  if (tokenFormatted[currentTokenFormat]) {
    qs('#token-output').textContent = tokenFormatted[currentTokenFormat];
  }

  // Render inventory
  if (!agg || (agg.colors.length === 0 && agg.fonts.length === 0 && agg.textStyles.length === 0 && agg.spacings.length === 0)) {
    qs('#token-results').innerHTML = '<div class="results-empty">No design tokens found</div>';
    return;
  }

  var html = '';

  // Colors
  if (agg.colors.length > 0) {
    html += '<div class="token-section-header">Colors <span class="token-section-count">' + agg.colors.length + '</span></div>';
    for (var ci = 0; ci < agg.colors.length; ci++) {
      var c = agg.colors[ci];
      html += '<div class="token-item">';
      html += '<div class="token-swatch" style="background:' + escHtml(c.value) + '"></div>';
      html += '<div class="token-detail">';
      html += '<div class="token-value">' + escHtml(c.value) + '</div>';
      if (c.usedIn.length > 0) {
        html += '<div class="token-usage">Used in: ' + escHtml(c.usedIn.join(', ')) + '</div>';
      }
      html += '</div>';
      html += '<input class="token-name-input" value="' + escHtml(c.suggestedName) + '">';
      html += '<span class="token-count">' + c.count + 'x</span>';
      html += '</div>';
    }
  }

  // Fonts
  if (agg.fonts.length > 0) {
    html += '<div class="token-section-header">Fonts <span class="token-section-count">' + agg.fonts.length + '</span></div>';
    for (var fi = 0; fi < agg.fonts.length; fi++) {
      var f = agg.fonts[fi];
      html += '<div class="token-item">';
      html += '<div class="token-detail">';
      html += '<div style="font-family:\'' + escHtml(f.family) + '\';font-size:13px">' + escHtml(f.family) + '</div>';
      html += '</div>';
      html += '<input class="token-name-input" value="' + escHtml(f.suggestedName) + '">';
      html += '<span class="token-count">' + f.count + 'x</span>';
      html += '</div>';
    }
  }

  // Text Styles
  if (agg.textStyles.length > 0) {
    html += '<div class="token-section-header">Text Styles <span class="token-section-count">' + agg.textStyles.length + '</span></div>';
    for (var ti = 0; ti < agg.textStyles.length; ti++) {
      var ts = agg.textStyles[ti];
      html += '<div class="token-item">';
      html += '<div class="token-detail">';
      html += '<div><strong>' + Math.round(ts.fontSize) + 'px</strong> / ' + ts.fontWeight + ' — ' + escHtml(ts.fontFamily) + '</div>';
      if (ts.textClass) {
        html += '<div class="token-value">' + escHtml(ts.textClass) + '</div>';
      }
      if (ts.usedIn.length > 0) {
        html += '<div class="token-usage">Used in: ' + escHtml(ts.usedIn.join(', ')) + '</div>';
      }
      html += '</div>';
      html += '<input class="token-name-input" value="' + escHtml(ts.suggestedName) + '">';
      html += '<span class="token-count">' + ts.count + 'x</span>';
      html += '</div>';
    }
  }

  // Spacing
  if (agg.spacings.length > 0) {
    html += '<div class="token-section-header">Spacing <span class="token-section-count">' + agg.spacings.length + '</span></div>';
    for (var si = 0; si < agg.spacings.length; si++) {
      var sp = agg.spacings[si];
      html += '<div class="token-item">';
      html += '<div class="token-detail">';
      html += '<div><strong>' + Math.round(sp.value) + 'px</strong></div>';
      html += '</div>';
      html += '<input class="token-name-input" value="' + escHtml(sp.suggestedName) + '">';
      html += '<span class="token-count">' + sp.count + 'x</span>';
      html += '</div>';
    }
  }

  // Spacing issues
  var spacingIssues = data.spacingIssues || [];
  if (spacingIssues.length > 0) {
    html += '<div class="token-section-header" style="color:#b45309">Spacing Issues <span class="token-section-count" style="background:#fef3c7;color:#92400e">' + spacingIssues.length + '</span></div>';
    for (var sii = 0; sii < spacingIssues.length; sii++) {
      var spIssue = spacingIssues[sii];
      html += '<div class="token-item" style="border-left:3px solid #f59e0b">';
      html += '<div class="token-detail">';
      html += '<div><strong>' + spIssue.value + 'px</strong> used ' + spIssue.count + 'x &rarr; suggest <strong>' + spIssue.suggestedValue + 'px</strong> (' + escHtml(spIssue.suggestedName) + ')</div>';
      html += '<div class="token-usage">Off by ' + spIssue.delta + 'px</div>';
      html += '</div>';
      html += '</div>';
    }
  }

  // Color duplicates
  var colorDuplicates = data.colorDuplicates || [];
  if (colorDuplicates.length > 0) {
    html += '<div class="token-section-header" style="color:#b45309">Near-Duplicate Colors <span class="token-section-count" style="background:#fef3c7;color:#92400e">' + colorDuplicates.length + '</span></div>';
    for (var cdi = 0; cdi < colorDuplicates.length; cdi++) {
      var group = colorDuplicates[cdi];
      html += '<div class="token-item" style="border-left:3px solid #f59e0b">';
      html += '<div style="display:flex;gap:4px;align-items:center">';
      for (var gi = 0; gi < group.colors.length; gi++) {
        var gc = group.colors[gi];
        html += '<div class="token-swatch" style="background:' + escHtml(gc.value) + '"></div>';
      }
      html += '</div>';
      html += '<div class="token-detail">';
      var colorLabels: string[] = [];
      for (var gl = 0; gl < group.colors.length; gl++) {
        colorLabels.push(escHtml(group.colors[gl].value) + ' (' + group.colors[gl].count + 'x)');
      }
      html += '<div>' + colorLabels.join(' &asymp; ') + '</div>';
      html += '<div class="token-usage">Consolidate to: <strong>' + escHtml(group.suggestedConsolidation) + '</strong></div>';
      html += '</div>';
      html += '</div>';
    }
  }

  qs('#token-results').innerHTML = html;
  (qs('#token-generate') as HTMLButtonElement).disabled = false;
}

// --- Message Handler ---
window.onmessage = (event: MessageEvent) => {
  const msg = event.data.pluginMessage;
  if (!msg) return;

  // FigmaKit Standards tab (standards-* messages)
  if (handleStandardsUIMessage(msg)) return;

  if (msg.type === 'scan-result') {
    switch (msg.feature) {
      case 'cleaner': renderCleanResults(msg.data); break;
      case 'renamer': renderRenameResults(msg.data); break;
      case 'validator': renderValidationReport(msg.data); break;
      case 'structure': renderStructureSummary(msg.data); break;
      case 'text-content': renderTextContent(msg.data); break;
      case 'variants': renderVariantResults(msg.data); break;
      case 'assets': renderAssetResults(msg.data); break;
      case 'tokens': renderTokens(msg.data); break;
      case 'bem': renderBEMResults(msg.data); break;
    }
    setStatus('Scan complete');
  } else if (msg.type === 'apply-result') {
    setStatus(`Applied: ${msg.feature}`);
    // Re-enable buttons
    qsa('.btn-primary').forEach(btn => {
      (btn as HTMLButtonElement).disabled = false;
    });
    // Another feature changed the document: Standards results may be stale,
    // and its buttons must keep their own enabled/disabled rules.
    onStandardsDocumentChanged();
  } else if (msg.type === 'export-blob') {
    // Download exported asset
    try {
      var uint8 = new Uint8Array(msg.bytes);
      var mimeType = msg.format === 'svg' ? 'image/svg+xml' : msg.format === 'pdf' ? 'application/pdf' : 'image/' + msg.format;
      var blob = new Blob([uint8], { type: mimeType });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = msg.name + '.' + msg.format;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      // ignore download error
    }
  } else if (msg.type === 'export-progress') {
    var pct = Math.round((msg.current / msg.total) * 100);
    qs('#export-progress-bar').style.width = pct + '%';
    qs('#export-progress-text').textContent = 'Exporting ' + msg.current + '/' + msg.total + '...';
  } else if (msg.type === 'export-complete') {
    qs('#export-progress-bar').style.width = '100%';
    qs('#export-progress-text').textContent = 'Export complete — ' + msg.count + ' assets';
    setStatus('Export complete');
  } else if (msg.type === 'error') {
    setStatus('Error: ' + msg.message);
  } else if (msg.type === 'selection-change') {
    onStandardsSelectionChange();
    if (msg.count === 0) {
      qs('#status-selection').textContent = 'No selection';
    } else if (msg.count === 1) {
      var selLabel = escHtml(msg.name || 'Unknown');
      if (msg.nodeType) selLabel += ' (' + msg.nodeType + ')';
      qs('#status-selection').textContent = selLabel;
    } else {
      qs('#status-selection').textContent = msg.count + ' selected';
    }
  }
};

// --- FigmaKit Standards tab ---
initStandardsUI({ post: post, setStatus: setStatus });
