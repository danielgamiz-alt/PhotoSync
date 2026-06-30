package com.photosync.app

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.recyclerview.widget.RecyclerView
import com.bumptech.glide.Glide

/**
 * Thin horizontal strip of thumbnails shown at the bottom of the full-screen
 * viewer (the "coming photos" preview from the mockup). The cell at
 * [selectedIndex] is drawn with a white border at full opacity; the rest are
 * dimmed. Tapping a cell asks the host to swipe the pager to that item.
 */
class ViewerFilmstripAdapter(
    private val items: List<MediaItem>,
    private val onCellClick: (index: Int) -> Unit,
) : RecyclerView.Adapter<ViewerFilmstripAdapter.CellHolder>() {

    private var selectedIndex = 0

    /** Moves the highlight to [index] and repaints the affected cells. */
    fun setSelected(index: Int) {
        if (index == selectedIndex || index !in items.indices) return
        val previous = selectedIndex
        selectedIndex = index
        notifyItemChanged(previous)
        notifyItemChanged(index)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): CellHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_filmstrip, parent, false)
        return CellHolder(view)
    }

    override fun onBindViewHolder(holder: CellHolder, position: Int) {
        val item = items[position]
        Glide.with(holder.thumb).load(item.uri).centerCrop().into(holder.thumb)
        val selected = position == selectedIndex
        holder.cell.foreground =
            if (selected) holder.cell.context.getDrawable(R.drawable.filmstrip_selected_border) else null
        holder.cell.alpha = if (selected) 1f else 0.55f
        holder.cell.setOnClickListener { onCellClick(holder.bindingAdapterPosition) }
    }

    override fun getItemCount(): Int = items.size

    class CellHolder(view: View) : RecyclerView.ViewHolder(view) {
        val cell: FrameLayout = view.findViewById(R.id.filmstripCell)
        val thumb: ImageView = view.findViewById(R.id.filmstripThumb)
    }
}
