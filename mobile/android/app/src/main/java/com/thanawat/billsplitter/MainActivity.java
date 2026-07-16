package com.thanawat.billsplitter;

import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;

import com.getcapacitor.BridgeActivity;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Capacitor's default WebView has no DownloadListener, so the web app's
 * "Export PDF" (jsPDF.save() -> blob: URL) and "Export image"
 * (canvas.toDataURL() -> data: URL) anchor-downloads are silently dropped —
 * the button does nothing and no file is written. This adds handling for both
 * URL schemes and writes the file into the public Downloads collection.
 *
 * - data: URLs are decoded natively right in the download listener.
 * - blob: URLs cannot be read from native code, so we ask the page's JS to
 *   fetch the blob and hand it back as a data: URL via the AndroidDownload
 *   bridge (the blob is still alive at download time — FileSaver/jsPDF only
 *   revokes it on a later timeout).
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = this.bridge.getWebView();
        webView.addJavascriptInterface(new DownloadBridge(), "AndroidDownload");
        // Cold start from a tapped guest/share link: navigate to that exact
        // URL (incl. #fragment) so the app routes straight to the guest view
        // instead of the default home page.
        loadDeepLink(getIntent());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            if (url == null) return;
            String filename = URLUtil.guessFileName(url, contentDisposition, mimetype);
            if (url.startsWith("data:")) {
                saveDataUrl(url, filename, mimetype);
            } else if (url.startsWith("blob:")) {
                // Route blob through the page's JS: fetch -> FileReader -> data URL.
                String js = "(function(){try{fetch('" + url + "').then(function(r){return r.blob();})"
                        + ".then(function(b){var fr=new FileReader();fr.onloadend=function(){"
                        + "AndroidDownload.saveBase64(String(fr.result),'" + escapeJs(filename) + "','" + escapeJs(mimetype) + "');};"
                        + "fr.readAsDataURL(b);}).catch(function(e){AndroidDownload.failed(String(e));});}"
                        + "catch(e){AndroidDownload.failed(String(e));}})()";
                webView.post(() -> webView.evaluateJavascript(js, null));
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // singleTask: a link tapped while the app is already running arrives
        // here instead of onCreate.
        setIntent(intent);
        loadDeepLink(intent);
    }

    /** If launched/resumed by a VIEW intent for our site, load that URL. */
    private void loadDeepLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri data = intent.getData();
        if (data == null) return;
        String url = data.toString();
        if (!url.startsWith("https://thanawat-ai-dev.github.io/bill-splitter-data")) return;
        WebView webView = this.bridge.getWebView();
        if (webView == null) return;
        webView.post(() -> webView.loadUrl(url));
    }

    private static String escapeJs(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("'", "\\'");
    }

    /** Decode a full "data:[<mime>][;base64],<payload>" URL and save it. */
    private void saveDataUrl(String dataUrl, String filename, String mimetype) {
        try {
            int comma = dataUrl.indexOf(',');
            if (comma < 0) { toast("บันทึกไฟล์ไม่สำเร็จ"); return; }
            String meta = dataUrl.substring(5, comma); // strip "data:"
            String payload = dataUrl.substring(comma + 1);
            byte[] bytes;
            if (meta.contains("base64")) {
                bytes = Base64.decode(payload, Base64.DEFAULT);
            } else {
                bytes = java.net.URLDecoder.decode(payload, "UTF-8").getBytes("UTF-8");
            }
            String mime = mimetype;
            if (mime == null || mime.isEmpty()) {
                mime = meta.contains(";") ? meta.substring(0, meta.indexOf(";")) : meta;
            }
            saveBytes(bytes, filename, mime);
        } catch (Exception e) {
            toast("บันทึกไฟล์ไม่สำเร็จ");
        }
    }

    /** Write bytes into public Downloads (MediaStore on Q+, direct file below). */
    private void saveBytes(byte[] bytes, String filename, String mimetype) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                if (mimetype != null && !mimetype.isEmpty()) {
                    values.put(MediaStore.Downloads.MIME_TYPE, mimetype);
                }
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                Uri item = getContentResolver().insert(collection, values);
                if (item == null) { toast("บันทึกไฟล์ไม่สำเร็จ"); return; }
                try (OutputStream os = getContentResolver().openOutputStream(item)) {
                    os.write(bytes);
                }
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(item, values, null, null);
            } else {
                // Pre-Q fallback: app-specific external dir needs no permission.
                File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir != null && !dir.exists()) dir.mkdirs();
                File out = new File(dir, filename);
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    fos.write(bytes);
                }
            }
            toast("บันทึกไฟล์แล้ว: " + filename);
        } catch (Exception e) {
            toast("บันทึกไฟล์ไม่สำเร็จ");
        }
    }

    private void toast(String msg) {
        runOnUiThread(() -> Toast.makeText(getApplicationContext(), msg, Toast.LENGTH_LONG).show());
    }

    /** Called from injected JS with a blob converted to a data: URL. */
    public class DownloadBridge {
        @JavascriptInterface
        public void saveBase64(String dataUrl, String filename, String mimetype) {
            saveDataUrl(dataUrl, filename, mimetype);
        }

        @JavascriptInterface
        public void failed(String error) {
            toast("ดาวน์โหลดไฟล์ไม่สำเร็จ");
        }
    }
}
