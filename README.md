# Fishbowl query report

Run the saved Fishbowl queries, or type a `SELECT` statement, from a local page.

Fishbowl's API is a server socket, so the page is opened through a small local helper. The helper reads `ServerHost`, `ServerPort`, `UserName`, `UserPassword`, `AppId`, `AppName`, and `AppDesc` from the environment. It listens only on `127.0.0.1`.

## Open the report

Windows: double-click `start-report.bat`.

Mac or Linux:

```bash
./start-report.sh
```

Then use the page at [http://127.0.0.1:8787/](http://127.0.0.1:8787/). `Fishbowl-Query-Report.html` is the same page and can be opened directly while the helper is running.

The first login registers the integrated application. Approve it once in the Fishbowl Client under Setup, Settings, Integrated Apps. That screen requires the Edit Integrated Apps right. The report shows the application name and a Check again button.

## PowerShell

`Test-FishbowlQueries.ps1` is the original legacy-port script with the syntax errors fixed. It uses the same environment variables and prints the five saved queries in the console.

```powershell
powershell -ExecutionPolicy Bypass -File .\Test-FishbowlQueries.ps1
```

## Checks

```bash
npm test
```
