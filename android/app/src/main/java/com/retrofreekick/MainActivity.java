package com.retrofreekick;

import android.app.Activity;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import java.util.Locale;

// Full-screen WebView hosting www/index.html from the APK assets.
public class MainActivity extends Activity {
    private WebView web;
    private TextToSpeech tts; // the commentator's voice: WebView has no Web Speech, so the game calls RFKVoice instead
    private volatile boolean ttsReady;

    // called from the game's JS (on the WebView's bridge thread)
    private class Voice {
        @JavascriptInterface
        public void speak(String text, float rate, float pitch) {
            if (!ttsReady || text == null) return;
            tts.setSpeechRate(rate);
            tts.setPitch(pitch);
            tts.speak(text.length() > 200 ? text.substring(0, 200) : text, TextToSpeech.QUEUE_FLUSH, null, "rfk");
        }

        @JavascriptInterface
        public void stop() { if (ttsReady) tts.stop(); }
    }

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
        tts = new TextToSpeech(this, (status) -> {
            if (status == TextToSpeech.SUCCESS) { tts.setLanguage(Locale.US); ttsReady = true; }
        });
        web.addJavascriptInterface(new Voice(), "RFKVoice");
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
    protected void onPause() { super.onPause(); web.onPause(); web.pauseTimers(); if (ttsReady) tts.stop(); } // no JS ticking or talking in the background

    @Override
    protected void onResume() { super.onResume(); web.onResume(); web.resumeTimers(); }

    @Override
    protected void onDestroy() { if (tts != null) tts.shutdown(); super.onDestroy(); }
}
