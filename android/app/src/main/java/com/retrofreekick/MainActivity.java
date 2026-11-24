package com.retrofreekick;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

// Full-screen WebView hosting www/index.html from the APK assets.
public class MainActivity extends Activity {
    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // best score in localStorage
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setBackgroundColor(0xFF000000);
        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() { // the game decides: back opens its menu, and only quits from the title screen
        web.evaluateJavascript("window.__back ? window.__back() : false", (r) -> { if (!"true".equals(r)) finish(); });
    }

    @Override
    protected void onPause() { super.onPause(); web.onPause(); web.pauseTimers(); } // no JS ticking in the background

    @Override
    protected void onResume() { super.onResume(); web.onResume(); web.resumeTimers(); }
}
