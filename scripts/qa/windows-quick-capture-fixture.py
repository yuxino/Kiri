"""Ordinary public desktop content for native screenshot/pinning acceptance."""

import sys
import tkinter as tk


width, height = map(int, sys.argv[1:])
root = tk.Tk()
root.title("Kiri public screenshot notes")
root.overrideredirect(True)
root.geometry(f"{width}x{height}+0+0")
canvas = tk.Canvas(root, background="#eeeeee", highlightthickness=0)
canvas.pack(fill="both", expand=True)
canvas.create_text(70, 65, anchor="nw", text="KIRI", font=("Segoe UI", 18, "bold"), fill="#111111")
canvas.create_text(70, 110, anchor="nw", text="Capture once. Keep it in view.",
                   font=("Segoe UI", 28, "bold"), fill="#111111")
canvas.create_rectangle(70, 190, 650, 425, fill="#ffffff", outline="")
canvas.create_text(100, 215, anchor="nw", text="SCREENSHOT TIPS",
                   font=("Segoe UI", 21, "bold"), fill="#111111")
canvas.create_text(100, 275, anchor="nw", text="Double-click the region to finish.\n"
                   "Choose Pin in the completion card.\n"
                   "Keep the image visible while you work.",
                   font=("Segoe UI", 17), fill="#333333")
canvas.create_text(70, 485, anchor="nw", text="Working in another app",
                   font=("Segoe UI", 20, "bold"), fill="#111111")
canvas.create_text(70, 535, anchor="nw", text="The reference stays above this window.",
                   font=("Segoe UI", 17), fill="#555555")
root.after(180000, root.destroy)
root.mainloop()
