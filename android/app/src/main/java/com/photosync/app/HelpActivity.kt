package com.photosync.app

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

/**
 * "How it works" + FAQ — a plain-language explanation of what PhotoSync does
 * and why it's home-Wi‑Fi-only, for anyone who forgets after setup. Reached
 * from the overflow menu and from a link in Settings. Content is static
 * (see activity_help.xml / strings.xml).
 */
class HelpActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_help)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }
}
