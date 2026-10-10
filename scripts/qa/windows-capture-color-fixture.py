"""Public desktop pixels for color QA; the shipping app captures them normally."""
import ctypes
import os
import sys

if os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("Use an isolated Windows CI desktop")
ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

import tkinter as tk

width, height = map(int, sys.argv[1:])
root = tk.Tk()
root.title("Kiri public color QA")
root.overrideredirect(True)
root.geometry(f"{width}x{height}+0+0")
canvas = tk.Canvas(root, background="#eeeeee", highlightthickness=0)
canvas.pack(fill="both", expand=True)
canvas.create_text(60, 90, anchor="nw", text="KIRI COLOR QA",
                   font=("Segoe UI", 26, "bold"), fill="#111111")
canvas.create_rectangle(60, 185, 420, 365, fill="#000302", outline="")
canvas.create_rectangle(440, 185, 800, 365, fill="#FA80FF", outline="")
canvas.create_rectangle(200, 240, 201, 241, fill="#102030", outline="")
canvas.create_rectangle(60, 435, 800, 610, fill="#ffffff", outline="")
canvas.create_text(90, 460, anchor="nw", text="KIRI COLOR QA\nLOCAL SCREEN TEXT",
                   font=("Segoe UI", 26, "bold"), fill="#111111")
root.after(240000, root.destroy)
root.mainloop()
