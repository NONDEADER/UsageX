/**
 * Google Apps Script Web App for Logging UsageX Feedback
 * 
 * Instructions:
 * 1. Create a new Google Spreadsheet.
 * 2. Click Extensions > Apps Script.
 * 3. Delete any code in the editor and paste this code.
 * 4. Save and click "Deploy" > "New Deployment".
 * 5. Choose "Web App", execute as "Me", and set who has access to "Anyone".
 * 6. Authorize the permissions, copy the Web App URL, and paste it into background.js.
 */

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    
    // Initialize headers if sheet is empty
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["Timestamp", "Type", "Email", "Message", "Diagnostics"]);
      sheet.getRange(1, 1, 1, 5)
           .setFontWeight("bold")
           .setBackground("#f3f3f3");
    }
    
    // Append the feedback row
    sheet.appendRow([
      new Date(),
      data.type || "General",
      data.email || "Anonymous",
      data.message || "",
      data.diagnostics || ""
    ]);
    
    // Send email alert to developer
    var emailRecipient = "nondeader.dev@gmail.com";
    var emailSubject = "[UsageX Feedback] New " + (data.type || "Feedback") + " Submission";
    var emailBody = "New feedback submitted via UsageX:\n\n" +
      "Type: " + (data.type || "General") + "\n" +
      "Email: " + (data.email || "Anonymous") + "\n\n" +
      "Message:\n" + (data.message || "") + "\n\n" +
      "Diagnostics:\n" + (data.diagnostics || "None");
      
    MailApp.sendEmail(emailRecipient, emailSubject, emailBody);
    
    return ContentService.createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
