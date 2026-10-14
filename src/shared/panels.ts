/**
 * A person's panels as the Home tab draws them (GET /api/hub/panels): each
 * thing read just now, its buttons worked out from what it is doing now — a
 * closed gate offers Open, a lit lamp Turn off — so nothing here is a copy
 * kept from before (src/worker/lib/panel-view.ts, src/app/ui/Home.ts).
 */

export interface PanelRow {
  /** Which thing it is on its panel (its entity id, car id, "usage", or the note), for a button press. */
  key: string;
  kind: "home" | "car" | "usage" | "note";
  label: string;
  /** What it is doing now, in words: "Closed", "On", "31 °C", "Locked". Empty for a note. */
  value: string;
  /** Figures side by side: a car's battery and range, what was used this month. */
  tiles: { label: string; value: string }[];
  /** What can be done to it now, from its state now. */
  actions: { action: string; label: string }[];
  /** Why it cannot be read or worked just now. */
  note?: string;
}

export interface PanelView {
  id: string;
  title: string;
  rows: PanelRow[];
}

export interface PanelsReply {
  panels: PanelView[];
  /** What a panel could show for this person, for the empty Home tab to say so. */
  can: { home: boolean; car: boolean };
}
