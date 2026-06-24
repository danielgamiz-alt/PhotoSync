package com.photosync.app

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton

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

        findViewById<MaterialButton>(R.id.supportButton).setOnClickListener {
            val url = getString(R.string.support_url)
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (e: ActivityNotFoundException) {
                Toast.makeText(this, url, Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }
}
