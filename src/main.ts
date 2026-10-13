import { analyzeNode, analyzeSelection } from './core/analyzer';
import { canRemove, canFlatten, isRedundantNesting } from './core/safety-check';
import { scanForCleaning, applyClean } from './features/cleaner';
import { scanForRenaming, applyRenames } from './features/renamer';
import { generateReport } from './features/validator';
import { applyLabel, batchLabel } from './features/labeler';
import { generateBEMNames, applyBEMNames } from './features/bem-formatter';
import { extractTokens, formatTokens } from './features/token-preview';
import { aggregateTokens } from './features/token-aggregator';
import { scanAssets } from './features/asset-analyzer';
import { generateStructureSummary } from './features/structure-summary';
import { checkSpacingConsistency } from './features/spacing-checker';
import { findColorDuplicates } from './features/color-checker';
import { extractTextContent } from './features/text-content';
import { mapVariantsToCSSModifiers } from './features/variant-mapper';
import { suggestAltText } from './features/alt-text';
import type { CleanActionItem, RenameAction } from './shared/types';
import { isStandardsMessage, handleStandardsMessage } from './standards-controller';

/**
 * Get the nodes to analyze: selection if available, otherwise all page children.
 */
function getTargetNodes(): any[] {
  try {
    var selection = figma.currentPage.selection;
    if (selection && selection.length > 0) {
      var result: any[] = [];
      for (var i = 0; i < selection.length; i++) {
        result.push(selection[i]);
      }
      return result;
    }
    var children = figma.currentPage.children;
    if (children && children.length > 0) {
      var result2: any[] = [];
      for (var j = 0; j < children.length; j++) {
        result2.push(children[j]);
      }
      return result2;
    }
    return [];
  } catch (e) {
    return [];
  }
}

/**
 * Handle a message from the UI.
 */
export async function handleMessage(msg: any): Promise<void> {
  try {
    var type = msg.type;

    if (type === 'scan') {
      await handleScan(msg);
    } else if (type === 'apply') {
      await handleApply(msg);
    } else if (isStandardsMessage(msg)) {
      await handleStandardsMessage(msg);
    } else {
      figma.ui.postMessage({ type: 'error', message: 'Unknown message type: ' + type });
    }
  } catch (err: any) {
    var errMsg = err.message || 'Unknown error';
    var errStack = err.stack || '';
    // Extract useful info from stack trace
    var location = '';
    if (errStack) {
      var lines = errStack.split('\n');
      for (var li = 0; li < Math.min(lines.length, 5); li++) {
        if (lines[li].indexOf('at ') >= 0) {
          location += lines[li].trim() + ' | ';
        }
      }
    }
    figma.ui.postMessage({
      type: 'error',
      message: errMsg + (location ? ' [' + location + ']' : ''),
    });
  }
}

async function handleScan(msg: any): Promise<void> {
  const { feature } = msg;
  const nodes = getTargetNodes();
  const results = analyzeSelection(nodes);

  switch (feature) {
    case 'cleaner': {
      const scan = scanForCleaning(results);
      var cleanTree = results.map(function serializeCleanTree(r: any): any {
        return {
          id: r.id,
          name: r.name,
          role: r.role,
          canRemove: r.canRemove,
          canFlatten: r.canFlatten,
          removeReason: r.removeReason,
          children: r.children.map(serializeCleanTree),
        };
      });
      figma.ui.postMessage({
        type: 'scan-result',
        feature: 'cleaner',
        data: {
          removable: serializeResults(scan.removable),
          flattenable: serializeResults(scan.flattenable),
          safe: serializeResults(scan.safe),
          tree: cleanTree,
        },
      });
      break;
    }

    case 'renamer': {
      const actions = scanForRenaming(results);
      // Build lookup of rename suggestions by node ID
      var renameMap: Record<string, string> = {};
      for (var ai = 0; ai < actions.length; ai++) {
        renameMap[actions[ai].nodeId] = actions[ai].suggestedName;
      }
      // Send tree structure with parent-context-aware rename suggestions
      const tree = results.map(function serializeTree(r: any): any {
        return {
          id: r.id,
          name: r.name,
          role: r.role,
          confidence: r.confidence,
          suggestedName: renameMap[r.id] || null,
          canFlatten: r.canFlatten,
          canRemove: r.canRemove,
          depth: r.depth,
          children: r.children.map(serializeTree),
        };
      });
      figma.ui.postMessage({
        type: 'scan-result',
        feature: 'renamer',
        data: {
          actions: actions.map(function(a: any) {
            return {
              nodeId: a.nodeId,
              currentName: a.currentName,
              suggestedName: a.suggestedName,
              confidence: a.confidence,
              source: a.source,
              node: a.node,
            };
          }),
          tree: tree,
        },
      });
      break;
    }

    case 'validator': {
      const report = generateReport(results);
      figma.ui.postMessage({
        type: 'scan-result',
        feature: 'validator',
        data: report,
      });
      break;
    }

    case 'tokens': {
      // Aggregate tokens from all nodes in the tree
      var aggregated = aggregateTokens(results);

      // Also get formatted output from first node for code preview
      var firstResult = results[0];
      var formatted: Record<string, string> = {};
      if (firstResult) {
        var tokens = extractTokens(firstResult);
        formatted = {
          css: formatTokens(tokens, 'css'),
          scss: formatTokens(tokens, 'scss'),
          utility: formatTokens(tokens, 'utility'),
          gutenberg: formatTokens(tokens, 'gutenberg'),
        };
      }

      var spacingIssues = checkSpacingConsistency(aggregated.spacings);
      var colorDuplicates = findColorDuplicates(aggregated.colors);

      figma.ui.postMessage({
        type: 'scan-result',
        feature: 'tokens',
        data: {
          aggregated: aggregated,
          formatted: formatted,
          spacingIssues: spacingIssues,
          colorDuplicates: colorDuplicates,
        },
      });
      break;
    }

    case 'bem': {
      const result = results[0];
      if (!result) {
        figma.ui.postMessage({ type: 'scan-result', feature: 'bem', data: [] });
        break;
      }
      const mappings = generateBEMNames(result);
      figma.ui.postMessage({
        type: 'scan-result',
        feature: 'bem',
        data: mappings.map(m => ({
          nodeId: m.nodeId,
          currentName: m.currentName,
          bemName: m.bemName,
          node: m.node,
        })),
      });
      break;
    }

    case 'structure': {
      var summary = generateStructureSummary(results);
      figma.ui.postMessage({
        type: 'scan-result',
        feature: 'structure',
        data: summary,
      });
      break;
    }

    case 'text-content': {
      var textItems = extractTextContent(results);
      figma.ui.postMessage({
        type: 'scan-result',
        feature: 'text-content',
        data: textItems,
      });
      break;
    }

    case 'variants': {
      var variantMappings = mapVariantsToCSSModifiers(results);
      figma.ui.postMessage({
        type: 'scan-result',
        feature: 'variants',
        data: variantMappings,
      });
      break;
    }

    case 'assets': {
      var assetList = scanAssets(results);
      // Generate thumbnails for each asset
      var assetsWithPreviews: any[] = [];
      for (var assetIdx = 0; assetIdx < assetList.length; assetIdx++) {
        var asset = assetList[assetIdx];
        var preview = '';
        try {
          var assetNode = await figma.getNodeByIdAsync(asset.nodeId);
          if (assetNode && 'exportAsync' in assetNode) {
            var bytes = await (assetNode as any).exportAsync({
              format: 'PNG',
              constraint: { type: 'HEIGHT', value: 72 },
            });
            // Send raw bytes as regular array (Uint8Array doesn't serialize well)
            var byteArray: number[] = [];
            for (var bi = 0; bi < bytes.length; bi++) {
              byteArray.push(bytes[bi]);
            }
            preview = byteArray as any;
          }
        } catch (e) {
          // Skip preview on error
        }
        assetsWithPreviews.push({
          nodeId: asset.nodeId,
          name: asset.name,
          currentName: asset.currentName,
          suggestedName: asset.suggestedName,
          type: asset.type,
          format: asset.format,
          width: asset.width,
          height: asset.height,
          hasGoodName: asset.hasGoodName,
          issues: asset.issues,
          context: asset.context,
          preview: preview,
        });
      }
      // Generate alt text suggestions
      var altTexts = suggestAltText(results);
      var altMap: Record<string, string> = {};
      for (var ati = 0; ati < altTexts.length; ati++) {
        altMap[altTexts[ati].nodeId] = altTexts[ati].suggestedAlt;
      }
      // Attach alt text to each asset
      for (var awi = 0; awi < assetsWithPreviews.length; awi++) {
        assetsWithPreviews[awi].altText = altMap[assetsWithPreviews[awi].nodeId] || '';
      }

      figma.ui.postMessage({
        type: 'scan-result',
        feature: 'assets',
        data: assetsWithPreviews,
      });
      break;
    }

    default:
      figma.ui.postMessage({ type: 'error', message: 'Unknown feature: ' + feature });
  }
}

async function handleApply(msg: any): Promise<void> {
  var feature = msg.feature;

  switch (feature) {
    case 'cleaner': {
      var removed = 0;
      var flattened = 0;
      var actions = msg.actions || [];
      for (var ci = 0; ci < actions.length; ci++) {
        var action = actions[ci];
        var node = await figma.getNodeByIdAsync(action.nodeId);
        if (!node) continue;
        try {
          // Re-check safety on the live node: never trust the UI's list (the document may have
          // changed since the scan, e.g. a wrapper was turned into a component).
          if (action.action === 'remove' && !canRemove(node).safe) continue;
          if (action.action === 'flatten' && !canFlatten(node).safe && !isRedundantNesting(node).safe) continue;
          if (action.action === 'remove') {
            node.remove();
            removed++;
          } else if (action.action === 'flatten') {
            var parent = node.parent;
            if (parent && 'children' in node && (node as any).children.length === 1) {
              var child = (node as any).children[0];
              var idx = (parent as any).children.indexOf(node);
              child.x = (child.x || 0) + ((node as any).x || 0);
              child.y = (child.y || 0) + ((node as any).y || 0);
              (parent as any).insertChild(idx, child);
              node.remove();
              flattened++;
            }
          }
        } catch (e) {
          // Skip nodes that can't be removed (locked, top-level, etc.)
        }
      }
      figma.ui.postMessage({ type: 'apply-result', feature: 'cleaner', data: { removed: removed, flattened: flattened } });
      break;
    }

    case 'renamer': {
      var renameCount = 0;
      var renameActions = msg.actions || [];
      for (var ri = 0; ri < renameActions.length; ri++) {
        var rAction = renameActions[ri];
        var rNode = await figma.getNodeByIdAsync(rAction.nodeId);
        if (rNode) {
          rNode.name = rAction.suggestedName;
          renameCount++;
        }
      }
      figma.ui.postMessage({ type: 'apply-result', feature: 'renamer', data: renameCount });
      break;
    }

    case 'labeler': {
      if (msg.role && msg.mode) {
        // Single node label
        const nodes = getTargetNodes();
        if (nodes.length > 0) {
          applyLabel(nodes[0], msg.role, msg.mode);
        }
        figma.ui.postMessage({ type: 'apply-result', feature: 'labeler', data: 'ok' });
      } else if (msg.batchMode) {
        // Batch label
        const results = analyzeSelection(getTargetNodes());
        const count = batchLabel(results, msg.mode ?? 'prefix');
        figma.ui.postMessage({ type: 'apply-result', feature: 'labeler', data: count });
      }
      break;
    }

    case 'bem': {
      const nodes = getTargetNodes();
      const results = analyzeSelection(nodes);
      if (results.length > 0) {
        const count = applyBEMNames(results[0], msg.includeModifiers ?? false);
        figma.ui.postMessage({ type: 'apply-result', feature: 'bem', data: count });
      } else {
        figma.ui.postMessage({ type: 'apply-result', feature: 'bem', data: 0 });
      }
      break;
    }

    case 'assets': {
      // Rename assets by node ID
      var assetRenameCount = 0;
      var assetActions = msg.actions || [];
      for (var ai = 0; ai < assetActions.length; ai++) {
        var aAction = assetActions[ai];
        var aNode = await figma.getNodeByIdAsync(aAction.nodeId);
        if (aNode) {
          aNode.name = aAction.newName;
          assetRenameCount++;
        }
      }
      figma.ui.postMessage({ type: 'apply-result', feature: 'assets', data: assetRenameCount });
      break;
    }

    case 'export-all': {
      var exportAssets = msg.assets || [];
      var exportTotal = exportAssets.length;
      for (var exi = 0; exi < exportAssets.length; exi++) {
        try {
          var exAsset = exportAssets[exi];
          var exNode = await figma.getNodeByIdAsync(exAsset.nodeId);
          if (exNode && 'exportAsync' in exNode) {
            var exFormat = exAsset.format || 'PNG';
            var exScale = exAsset.scale || 1;
            var exportSettings: any = { format: exFormat };
            if (exFormat !== 'SVG' && exFormat !== 'PDF') {
              exportSettings.constraint = { type: 'SCALE', value: exScale };
            }
            var exBytes = await (exNode as any).exportAsync(exportSettings);
            var exByteArray: number[] = [];
            for (var ebi = 0; ebi < exBytes.length; ebi++) {
              exByteArray.push(exBytes[ebi]);
            }
            figma.ui.postMessage({
              type: 'export-blob',
              name: exAsset.name || 'asset',
              format: exFormat.toLowerCase(),
              bytes: exByteArray,
            });
          }
          figma.ui.postMessage({
            type: 'export-progress',
            current: exi + 1,
            total: exportTotal,
          });
        } catch (e) {
          // Skip failed exports
        }
      }
      figma.ui.postMessage({ type: 'export-complete', count: exportTotal });
      break;
    }

    case 'export-settings': {
      var exportCount = 0;
      var exportList = msg.exports || [];
      for (var ei = 0; ei < exportList.length; ei++) {
        var exp = exportList[ei];
        try {
          var expNode = await figma.getNodeByIdAsync(exp.nodeId);
          if (expNode && 'exportSettings' in expNode) {
            var settings: any[] = [];
            var format = exp.format || 'PNG';
            var scale = exp.scale || 1;

            if (format === 'SVG') {
              settings.push({ format: 'SVG', suffix: '', contentsOnly: true });
            } else if (format === 'PDF') {
              settings.push({ format: 'PDF', suffix: '', contentsOnly: true });
            } else {
              // PNG or JPG — add 1x base
              settings.push({
                format: format,
                suffix: '',
                constraint: { type: 'SCALE', value: 1 },
                contentsOnly: true,
              });
              // Add higher scale if requested
              if (scale >= 2) {
                settings.push({
                  format: format,
                  suffix: '@2x',
                  constraint: { type: 'SCALE', value: 2 },
                  contentsOnly: true,
                });
              }
              if (scale >= 3) {
                settings.push({
                  format: format,
                  suffix: '@3x',
                  constraint: { type: 'SCALE', value: 3 },
                  contentsOnly: true,
                });
              }
            }

            (expNode as any).exportSettings = settings;
            exportCount++;
          }
        } catch (e) {
          // Skip nodes that can't have export settings
        }
      }
      figma.ui.postMessage({ type: 'apply-result', feature: 'export-settings', data: exportCount });
      break;
    }

    default:
      figma.ui.postMessage({ type: 'error', message: 'Unknown feature: ' + feature });
  }
}

/**
 * Serialize analysis results for posting to UI (strip node references for large trees).
 */
function serializeResults(results: any[]): any[] {
  return results.map(r => ({
    id: r.id,
    name: r.name,
    role: r.role,
    confidence: r.confidence,
    canRemove: r.canRemove,
    canFlatten: r.canFlatten,
    removeReason: r.removeReason,
    node: r.node,
  }));
}

/**
 * Set up the message handler for the plugin.
 */
export function setupMessageHandler(): void {
  figma.ui.onmessage = handleMessage;
}

// --- Plugin initialization ---
// Guard: only run in Figma sandbox (not in test environment)
if (typeof figma !== 'undefined' && typeof __html__ !== 'undefined') {
  figma.showUI(__html__, { width: 480, height: 600 });
  setupMessageHandler();

  // Track selection changes
  figma.on('selectionchange', function() {
    try {
      var sel = figma.currentPage.selection;
      var count = sel.length;
      var name = '';
      var type = '';
      if (count === 1) {
        try { name = sel[0].name || ''; } catch (e) { name = ''; }
        try { type = sel[0].type || ''; } catch (e) { type = ''; }
      }
      figma.ui.postMessage({
        type: 'selection-change',
        count: count,
        name: name,
        nodeType: type,
      });
    } catch (e) {
      // ignore
    }
  });
}
