# UsageX v2

Firefox Manifest V3 extension that tracks Claude.ai usage and renders a Shadow DOM sidebar directly on the page.

## Folder structure

```text
UsageX v2/
|-- manifest.json
|-- background.js
|-- content.js
|-- storage.js
|-- sidebar.html
|-- sidebar.css
|-- README.md
`-- icons/
    |-- icon16.png
    |-- icon48.png
    `-- icon128.png
```

## Dependencies

- Firefox with MV3 extension support
- No external libraries

## How to run

1. Open Firefox.
2. Go to `about:debugging#/runtime/this-firefox`.
3. Click `Load Temporary Add-on`.
4. Select [manifest.json](C:/Users/User/OneDrive/Documents/UsageX%20v2/manifest.json).
5. Open `https://claude.ai/` and start using Claude.

## Notes

- The token counter is intentionally approximate and is labeled `~est` in the UI.
- The sidebar is isolated with Shadow DOM so Claude styles do not leak in.
- The extension uses only `browser.storage.local` and makes no external network calls.
