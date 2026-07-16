# Guest-link deep linking (Android App Links)

The app declares an App Links intent-filter for
`https://thanawat-ai-dev.github.io/bill-splitter-data` (see AndroidManifest.xml)
and `MainActivity.loadDeepLink()` navigates the WebView to the tapped URL.

For a tapped guest link to open **directly in the app** (no browser, no
chooser), Android verifies the app against a Digital Asset Links file served
from the **domain root**:

    https://thanawat-ai-dev.github.io/.well-known/assetlinks.json

GitHub Pages serves this project at the `/bill-splitter-data/` sub-path, so the
file **cannot** live in this repo. It must be hosted by a repo named
`Thanawat-AI-dev/thanawat-ai-dev.github.io` (a GitHub *user* Pages site), at:

    /.well-known/assetlinks.json   ->   assetlinks.json in this folder

## Fingerprints

`assetlinks.json` currently lists the **debug** keystore SHA-256
(`~/.android/debug.keystore`) — valid only for debug-signed builds installed for
testing. Before distributing a **release** APK, add that keystore's SHA-256 too:

    keytool -list -v -keystore <release.keystore> -alias <alias>

Add each fingerprint string to the `sha256_cert_fingerprints` array.

## After hosting

Re-trigger verification (or reinstall the app):

    adb shell pm verify-app-links --re-verify com.thanawat.billsplitter
    adb shell pm get-app-links com.thanawat.billsplitter   # check "verified"
