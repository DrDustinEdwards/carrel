// Carrel's panel in Google Docs (the Docs plan, slice 6). A Workspace add-on in Dustin's account alone: it sends the
// Doc, his request and the words he selected to Carrel, which does the job with its own engine and the model and effort
// set on Desk's AI page (app/lib/google/panel.server.ts). Carrel checks who sent it by the Google ID token below and
// answers only the Owner. Setup: addon/README.md.

var CARREL = "https://carrel-mcp.dustinedwards.info/docs-panel";

var JOBS = [
  ["edit", "Suggest edits"],
  ["new", "Write new text"],
  ["review", "Review and comment"],
  ["write", "Write directly"],
];

/** The panel: asks for this Doc first, then the request form. */
function onHome(e) {
  var doc = e && e.docs && e.docs.id;
  if (!doc || !e.docs.addonHasFileScopePermission) return [askForDoc()];
  return [form(selectedText())];
}

function askForDoc() {
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle("Carrel"))
    .addSection(
      CardService.newCardSection()
        .addWidget(
          CardService.newTextParagraph().setText(
            "Carrel needs this Doc open to it before it can work here.",
          ),
        )
        .addWidget(
          CardService.newTextButton()
            .setText("Open this Doc to Carrel")
            .setOnClickAction(CardService.newAction().setFunctionName("requestDoc")),
        ),
    )
    .build();
}

function requestDoc() {
  return CardService.newEditorFileScopeActionResponseBuilder()
    .requestFileScopeForActiveDocument()
    .build();
}

/** The words selected in the Doc, if Docs gives them to the add-on; else empty, and Dustin can paste them. */
function selectedText() {
  try {
    var selection = DocumentApp.getActiveDocument().getSelection();
    if (!selection) return "";
    return selection
      .getRangeElements()
      .map(function (part) {
        var element = part.getElement();
        if (!element.editAsText) return "";
        var text = element.asText().getText();
        return part.isPartial()
          ? text.slice(part.getStartOffset(), part.getEndOffsetInclusive() + 1)
          : text;
      })
      .join("\n")
      .slice(0, 5000);
  } catch (error) {
    return "";
  }
}

function form(selection, note) {
  var job = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.RADIO_BUTTON)
    .setTitle("What Carrel does")
    .setFieldName("job");
  JOBS.forEach(function (j, i) {
    job.addItem(j[1], j[0], i === 0);
  });
  var section = CardService.newCardSection();
  if (note) section.addWidget(CardService.newTextParagraph().setText(note));
  section
    .addWidget(
      CardService.newTextInput().setFieldName("ask").setTitle("Your request").setMultiline(true),
    )
    .addWidget(
      CardService.newTextInput()
        .setFieldName("selection")
        .setTitle("The words it is about (optional)")
        .setMultiline(true)
        .setValue(selection || ""),
    )
    .addWidget(job)
    .addWidget(
      CardService.newTextButton()
        .setText("Send to Carrel")
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setOnClickAction(CardService.newAction().setFunctionName("send")),
    );
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle("Carrel"))
    .addSection(section)
    .build();
}

function value(e, name) {
  var input = e.commonEventObject.formInputs && e.commonEventObject.formInputs[name];
  return input && input.stringInputs ? input.stringInputs.value[0] : "";
}

/** Sends the request and shows Carrel's answer in place of the form. */
function send(e) {
  var choice = value(e, "job") || "edit";
  var body = {
    doc: e.docs.id,
    ask: value(e, "ask"),
    job: choice === "write" ? "edit" : choice,
    mode: choice === "write" ? "write" : "suggest",
    selection: value(e, "selection"),
  };
  var response = UrlFetchApp.fetch(CARREL, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + ScriptApp.getIdentityToken() },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  var answer = {};
  try {
    answer = JSON.parse(response.getContentText());
  } catch (error) {}
  var note = answer.error
    ? "Carrel could not do it: " + answer.error
    : answer.engine === "subscription"
      ? "Carrel's routine is doing it. The changes appear in this Doc in a few minutes."
      : "Done. " +
        (answer.note || "") +
        (answer.skipped && answer.skipped.length
          ? " " + answer.skipped.length + " could not be placed."
          : "");
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(form(body.selection, note)))
    .build();
}
