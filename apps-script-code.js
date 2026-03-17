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
