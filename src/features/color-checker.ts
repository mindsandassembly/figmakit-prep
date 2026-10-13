export interface ColorDuplicateGroup {
  colors: Array<{ value: string; count: number; suggestedName: string }>;
  suggestedConsolidation: string;
}

function parseHexToRGB(hex: string): { r: number; g: number; b: number } | null {
  var clean = hex.replace('#', '');
  if (clean.length === 3) {
    clean = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2];
  }
  if (clean.length !== 6) return null;
  var r = parseInt(clean.substring(0, 2), 16);
  var g = parseInt(clean.substring(2, 4), 16);
  var b = parseInt(clean.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return { r: r, g: g, b: b };
}

function parseRgbaToRGB(rgba: string): { r: number; g: number; b: number } | null {
  var match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(rgba);
  if (!match) return null;
  return { r: parseInt(match[1]), g: parseInt(match[2]), b: parseInt(match[3]) };
}

export function parseColorToRGB(value: string): { r: number; g: number; b: number } | null {
  if (value.charAt(0) === '#') return parseHexToRGB(value);
  if (value.indexOf('rgb') === 0) return parseRgbaToRGB(value);
  return null;
}

export function colorDistance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  var dr = a.r - b.r;
  var dg = a.g - b.g;
  var db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Find near-duplicate colors using RGB Euclidean distance.
 * Groups colors within distance < 15.
 */
export function findColorDuplicates(colors: any[]): ColorDuplicateGroup[] {
  // Parse all colors to RGB
  var parsed: Array<{ rgb: { r: number; g: number; b: number }; value: string; count: number; suggestedName: string; groupId: number }> = [];
  for (var i = 0; i < colors.length; i++) {
    var rgb = parseColorToRGB(colors[i].value);
    if (rgb) {
      parsed.push({
        rgb: rgb,
        value: colors[i].value,
        count: colors[i].count || 1,
        suggestedName: colors[i].suggestedName || '',
        groupId: -1,
      });
    }
  }

  // Group by proximity (union-find style)
  var nextGroup = 0;
  for (var a = 0; a < parsed.length; a++) {
    for (var b = a + 1; b < parsed.length; b++) {
      var dist = colorDistance(parsed[a].rgb, parsed[b].rgb);
      if (dist < 15 && dist > 0) {
        if (parsed[a].groupId === -1 && parsed[b].groupId === -1) {
          parsed[a].groupId = nextGroup;
          parsed[b].groupId = nextGroup;
          nextGroup++;
        } else if (parsed[a].groupId >= 0 && parsed[b].groupId === -1) {
          parsed[b].groupId = parsed[a].groupId;
        } else if (parsed[b].groupId >= 0 && parsed[a].groupId === -1) {
          parsed[a].groupId = parsed[b].groupId;
        } else if (parsed[a].groupId !== parsed[b].groupId) {
          // Merge groups
          var oldGroup = parsed[b].groupId;
          var newGroup = parsed[a].groupId;
          for (var m = 0; m < parsed.length; m++) {
            if (parsed[m].groupId === oldGroup) parsed[m].groupId = newGroup;
          }
        }
      }
    }
  }

  // Collect groups
  var groupMap: Record<number, ColorDuplicateGroup> = {};
  for (var g = 0; g < parsed.length; g++) {
    if (parsed[g].groupId < 0) continue;
    var gid = parsed[g].groupId;
    if (!groupMap[gid]) {
      groupMap[gid] = { colors: [], suggestedConsolidation: '' };
    }
    groupMap[gid].colors.push({
      value: parsed[g].value,
      count: parsed[g].count,
      suggestedName: parsed[g].suggestedName,
    });
  }

  // Set suggested consolidation (highest count)
  var groups: ColorDuplicateGroup[] = [];
  var groupIds = Object.keys(groupMap);
  for (var gi = 0; gi < groupIds.length; gi++) {
    var group = groupMap[groupIds[gi] as any];
    if (group.colors.length < 2) continue;
    group.colors.sort(function(x, y) { return y.count - x.count; });
    group.suggestedConsolidation = group.colors[0].value;
    groups.push(group);
  }

  return groups;
}
