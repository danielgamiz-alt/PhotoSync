package com.photosync.app

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton

/**
 * About + FAQ — a plain-language explanation of what PhotoSync does and why it's
 * home-Wi‑Fi-only, for anyone who forgets after setup. Reached from the overflow
 * menu and from a link in Settings. The Common Questions are collapsed by
 * default and expand on tap (see [wireFaq]).
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

        wireFaq()
    }

    /** Makes each FAQ question a tap-to-expand row over its (hidden) answer. */
    private fun wireFaq() {
        val pairs = listOf(
            R.id.qWifi to R.id.aWifi,
            R.id.qServer to R.id.aServer,
            R.id.qInternet to R.id.aInternet,
            R.id.qBackground to R.id.aBackground,
            R.id.qLocked to R.id.aLocked,
            R.id.qMissing to R.id.aMissing,
            R.id.qFree to R.id.aFree,
        )
        for ((qId, aId) in pairs) {
            val question = findViewById<TextView>(qId)
            val answer = findViewById<TextView>(aId)
            val base = question.text.toString()
            answer.visibility = View.GONE
            question.text = "▸  $base"
            question.setOnClickListener {
                val expanded = answer.visibility == View.VISIBLE
                answer.visibility = if (expanded) View.GONE else View.VISIBLE
                question.text = (if (expanded) "▸  " else "▾  ") + base
            }
        }
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }
}
