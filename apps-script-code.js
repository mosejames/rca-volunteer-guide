function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet();
    var data = JSON.parse(e.postData.contents);
    var action = data.action;
    if (action === "write") {
      var tabName = data.tabName;
      var rows = data.rows;
      var headers = data.headers || ["day","time_start","time_end","groups","location","note","flag"];
      var mode = data.mode || "replace";
      var tab = sheet.getSheetByName(tabName);
      if (!tab) { tab = sheet.insertSheet(tabName); }
      if (mode === "replace") { tab.clear(); tab.appendRow(headers); }
      rows.forEach(function(row) {
        var values = headers.map(function(h) { return row[h] || ""; });
        tab.appendRow(values);
      });
      return ContentService.createTextOutput(JSON.stringify({success: true, tabName: tabName})).setMimeType(ContentService.MimeType.JSON);
    }
    if (action === "duplicate-template") {
      var newTabName = data.newTabName;
      var template = sheet.getSheetByName("TEMPLATE");
      if (!template) {
        return ContentService.createTextOutput(JSON.stringify({error: "TEMPLATE tab not found"})).setMimeType(ContentService.MimeType.JSON);
      }
      var existing = sheet.getSheetByName(newTabName);
      if (existing) {
        return ContentService.createTextOutput(JSON.stringify({error: "Tab already exists"})).setMimeType(ContentService.MimeType.JSON);
      }
      var newSheet = template.copyTo(sheet);
      newSheet.setName(newTabName);
      return ContentService.createTextOutput(JSON.stringify({success: true, tabName: newTabName})).setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify({error: "Unknown action"})).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({error: err.message})).setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// PUBLISH TO VOLUNTEER GUIDE
// ============================================================
// Reads a working grid tab (staff columns x time rows) and
// converts it to the flat format the volunteer guide needs.
//
// Grid format:
//   Row 1: Day name | Staff1 | Staff2 | Staff3 | ... | LUNCH
//   Row 2: "Location" | room1 | room2 | room3 | ... | (ignored)
//   Row 3+: "H:MM-H:MM" | cell | cell | cell | ... | lunch info
//
// The converter scans each cell for letter groups (A-L patterns)
// and creates flat rows for the volunteer guide.
// ============================================================

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu("Volunteer Guide")
    .addItem("Publish Current Tab", "publishCurrentTab")
    .addToUi();
}

function publishCurrentTab() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var source = ss.getActiveSheet();
  var sourceName = source.getName();

  // Don't publish from system tabs
  var systemTabs = ["Locations", "TEMPLATE", "Duties"];
  if (systemTabs.indexOf(sourceName) !== -1) {
    SpreadsheetApp.getUi().alert("Switch to a working schedule tab first (not " + sourceName + ").");
    return;
  }

  var data = source.getDataRange().getValues();
  if (data.length < 3) {
    SpreadsheetApp.getUi().alert("This tab needs at least 3 rows: header, location map, and time blocks.");
    return;
  }

  // Row 1: day name in A1, staff names in B1, C1, etc.
  var dayName = String(data[0][0]).trim();
  var staffNames = [];
  for (var c = 1; c < data[0].length; c++) {
    var name = String(data[0][c]).trim();
    if (name && name.toUpperCase() !== "LUNCH" && name.toUpperCase() !== "PARENTS") {
      staffNames.push({col: c, name: name});
    }
  }

  // Row 2: location mapping
  var locationMap = {};
  for (var i = 0; i < staffNames.length; i++) {
    var col = staffNames[i].col;
    var loc = String(data[1][col]).trim();
    if (loc) {
      locationMap[col] = loc;
    }
  }

  // Letter group pattern: 2+ uppercase letters A-L, or "ALL"
  var letterPattern = /^([A-L]{2,}|ALL)$/;
  // Mixed pattern: contains letter groups somewhere in the cell
  var mixedPattern = /\b([A-L]{2,})\b/g;

  var flatRows = [];

  // Row 3+: time blocks
  for (var r = 2; r < data.length; r++) {
    var timeCell = String(data[r][0]).trim();
    if (!timeCell) continue;

    // Parse time range "H:MM-H:MM" or "H:MM - H:MM"
    var timeParts = timeCell.match(/(\d{1,2}:\d{2})\s*[-\u2013]\s*(\d{1,2}:\d{2})/);
    if (!timeParts) continue;

    var timeStart = timeParts[1];
    var timeEnd = timeParts[2];

    // Check if this is an ALL row (every staff column has the same value)
    var allValues = [];
    for (var s = 0; s < staffNames.length; s++) {
      var v = String(data[r][staffNames[s].col]).trim().toUpperCase();
      if (v) allValues.push(v);
    }
    var uniqueValues = allValues.filter(function(v, i, a) { return a.indexOf(v) === i; });

    // If all non-empty cells have the same value, it's an ALL event
    if (uniqueValues.length === 1 && allValues.length > staffNames.length * 0.5) {
      var val = String(data[r][staffNames[0].col]).trim();
      // Skip ARRIVE, skip empty
      if (val.toUpperCase() !== "ARRIVE" && val) {
        flatRows.push({
          day: dayName,
          time_start: timeStart,
          time_end: timeEnd,
          groups: "ALL",
          location: val,
          note: "",
          flag: "all"
        });
      }
      continue;
    }

    // Scan each staff column for letter group assignments
    var foundGroups = {};  // track groups to avoid duplicates in same time block

    for (var s = 0; s < staffNames.length; s++) {
      var col = staffNames[s].col;
      var cell = String(data[r][col]).trim();
      if (!cell) continue;

      var cellUpper = cell.toUpperCase();

      // Skip non-assignment cells
      if (cellUpper === "ARRIVE" || cellUpper === "LUNCH" || cellUpper === "BREAK" ||
          cellUpper === "X" || cellUpper === "GET LUNCH" || cellUpper === "MEET" ||
          cellUpper === "CLEAN" || cellUpper === "RESET") continue;

      // Determine the location for this column
      var location = locationMap[col] || staffNames[s].name;

      // Check if cell contains letter groups
      var letterGroups = [];
      var remainingText = cell;

      // Check for exact match first (whole cell is a letter group)
      if (letterPattern.test(cellUpper)) {
        letterGroups.push(cellUpper);
        remainingText = "";
      } else {
        // Look for letter groups mixed with other text
        var match;
        var regex = /\b([A-L]{2,})\b/g;
        while ((match = regex.exec(cellUpper)) !== null) {
          letterGroups.push(match[1]);
        }
        // If cell has a grade group (4th, 5a, 5aa, etc.) use it as location
        var gradeMatch = cellUpper.match(/\b(\d+(?:TH|ST|ND|RD|[AB]|AA))\b/i);
        if (gradeMatch) {
          location = gradeMatch[0].toLowerCase();
        }
      }

      // If we found letter groups, create rows
      if (letterGroups.length > 0) {
        for (var g = 0; g < letterGroups.length; g++) {
          var groupKey = letterGroups[g] + "|" + location;
          if (!foundGroups[groupKey]) {
            foundGroups[groupKey] = true;

            // Determine flag
            var flag = "";
            if (letterGroups[g] === "ALL") flag = "all";

            flatRows.push({
              day: dayName,
              time_start: timeStart,
              time_end: timeEnd,
              groups: letterGroups[g],
              location: location,
              note: "",
              flag: flag
            });
          }
        }
      }
      // If cell is just a grade group with no letter group, it might be a location
      // where all current groups go. Skip these as they're staff-facing.
    }
  }

  if (flatRows.length === 0) {
    SpreadsheetApp.getUi().alert("No volunteer group assignments found. Make sure cells contain letter groups like ABCDEFGH, IJKL, etc.");
    return;
  }

  // Determine output tab name (use source tab name if it looks like a day tab)
  var outputTabName = sourceName;
  if (sourceName.indexOf("Working") === 0) {
    outputTabName = sourceName.replace("Working - ", "").replace("Working ", "");
  }

  // Ask user to confirm
  var ui = SpreadsheetApp.getUi();
  var response = ui.alert(
    "Publish to Volunteer Guide",
    "Found " + flatRows.length + " schedule entries.\n\n" +
    "This will write to tab: " + outputTabName + "\n" +
    "The volunteer guide will pick up changes within 45 seconds.\n\n" +
    "Continue?",
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) return;

  // Write to output tab
  var outputTab = ss.getSheetByName(outputTabName);
  if (!outputTab) {
    outputTab = ss.insertSheet(outputTabName);
  }
  outputTab.clear();

  var headers = ["day", "time_start", "time_end", "groups", "location", "note", "flag"];
  outputTab.appendRow(headers);

  flatRows.forEach(function(row) {
    outputTab.appendRow(headers.map(function(h) { return row[h] || ""; }));
  });

  ui.alert("Published " + flatRows.length + " entries to '" + outputTabName + "'.\n\nVolunteers will see the updated schedule within 45 seconds.");
}
