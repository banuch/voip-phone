"""Tkinter user interface (MicroSIP-style compact softphone)."""
import os
import queue
import threading
import time
import tkinter as tk
from collections import deque
from tkinter import filedialog, messagebox, simpledialog, ttk

from . import APP_NAME, APP_VERSION, config
from .ari import AriClient, AriError, default_url
from .audio import (AudioEngine, FilePlayer, list_devices, make_ringback, make_ringtone,
                    play_buffer, resolve_device, stop_buffer)
from .filedecode import FILE_TYPES, load_audio_8k
from .sdp import CODEC_PTS
from .sip_ua import SipUA

KEYS = [('1', ''), ('2', 'ABC'), ('3', 'DEF'), ('4', 'GHI'), ('5', 'JKL'), ('6', 'MNO'),
        ('7', 'PQRS'), ('8', 'TUV'), ('9', 'WXYZ'), ('*', ''), ('0', '+'), ('#', '')]
GREEN, GREEN_D = '#2e9e44', '#257d36'
RED, RED_D = '#d9534f', '#b52b27'
GREY = '#9a9a9a'
ORANGE = '#f0ad4e'
FONT = 'Segoe UI'
DIR_ICON = {'out': '↗ Out', 'in': '↙ In', 'missed': '✗ Missed'}
ROW_BG = '#ffffff'
MAX_ROWS = 200


def _natural_key(ext):
    return (0, int(ext), '') if ext.isdigit() else (1, 0, ext.lower())


class ScrollFrame(ttk.Frame):
    """Vertically scrollable frame; widgets go into .inner."""

    def __init__(self, parent, bg=ROW_BG):
        super().__init__(parent)
        self.canvas = tk.Canvas(self, highlightthickness=1, highlightbackground='#d0d0d0', bg=bg, bd=0)
        sb = ttk.Scrollbar(self, orient='vertical', command=self.canvas.yview)
        self.inner = tk.Frame(self.canvas, bg=bg)
        self._win = self.canvas.create_window((0, 0), window=self.inner, anchor='nw')
        self.canvas.configure(yscrollcommand=sb.set)
        self.canvas.pack(side='left', fill='both', expand=True)
        sb.pack(side='left', fill='y')
        self.inner.bind('<Configure>', lambda e: self.canvas.configure(scrollregion=self.canvas.bbox('all')))
        self.canvas.bind('<Configure>', lambda e: self.canvas.itemconfigure(self._win, width=e.width))
        self.bind_all('<MouseWheel>', self._on_wheel, add='+')

    def _on_wheel(self, e):
        w = self.winfo_containing(e.x_root, e.y_root)
        if w is None or not str(w).startswith(str(self)):
            return
        if self.inner.winfo_height() > self.canvas.winfo_height():
            self.canvas.yview_scroll(int(-e.delta / 120), 'units')

    def clear(self):
        for w in self.inner.winfo_children():
            w.destroy()
        self.canvas.yview_moveto(0)


def fmt_dur(sec):
    sec = int(sec)
    return f'{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}' if sec >= 3600 else f'{sec // 60:02d}:{sec % 60:02d}'


class PhoneApp:
    # ======================================================================
    # setup
    # ======================================================================
    def __init__(self):
        self.cfg = config.load()
        self.root = tk.Tk()
        self.root.title(APP_NAME)
        self.root.geometry(self.cfg.get('geometry') or '400x720')
        self.root.minsize(380, 640)
        self.q = queue.Queue()
        self.engine = AudioEngine()
        self._apply_audio_cfg()
        self.ua = SipUA(self)
        self.call = None
        self.last_end_text = ''
        self.dtmf_sent = ''
        self.dir_entries = []
        self.dir_error = ''
        self.dir_updated = None
        self.dir_sig = None
        self.dir_wakeup = threading.Event()
        self._closing = False
        self.tone_active = None
        self.audio_cache = {}
        self.sip_log = deque(maxlen=3000)
        self.log_text = None
        self._ua_busy = threading.Lock()

        self._setup_style()
        self._build_menu()
        self._build_ui()
        self._refresh_voice_lists()
        self._refresh_contacts()
        self._refresh_history()
        self._refresh_call_ui()

        self.root.bind('<Key>', self._on_key)
        self.root.protocol('WM_DELETE_WINDOW', self.on_close)
        self.root.after(50, self._poll)
        self.root.after(250, self._tick)
        self._start_ua()
        self._render_extensions()
        threading.Thread(target=self._directory_loop, name='directory', daemon=True).start()
        if not self.cfg['account']['domain']:
            self.root.after(400, self.account_dialog)

    def run(self):
        self.root.mainloop()

    def _setup_style(self):
        style = ttk.Style(self.root)
        for theme in ('vista', 'winnative', 'clam'):
            if theme in style.theme_names():
                style.theme_use(theme)
                break
        style.configure('TNotebook.Tab', padding=(10, 4))
        style.configure('Peer.TLabel', font=(FONT, 11, 'bold'))
        style.configure('Status.TLabel', font=(FONT, 9))
        self.bg = style.lookup('TFrame', 'background') or self.root.cget('bg')

    def _build_menu(self):
        mb = tk.Menu(self.root)
        m = tk.Menu(mb, tearoff=False)
        m.add_command(label='Account…', command=self.account_dialog)
        m.add_command(label='Directory server (ARI)…', command=self.directory_dialog)
        m.add_command(label='Audio devices…', command=self.audio_dialog)
        m.add_separator()
        m.add_command(label='Re-register', command=self._start_ua)
        m.add_command(label='SIP log', command=self.show_log)
        m.add_separator()
        m.add_command(label='Exit', command=self.on_close)
        mb.add_cascade(label='Phone', menu=m)
        h = tk.Menu(mb, tearoff=False)
        h.add_command(label='About', command=lambda: messagebox.showinfo(
            APP_NAME, f'{APP_NAME} {APP_VERSION}\n\nSIP softphone (UDP, G.711 PCMU/PCMA, RFC 4733 DTMF)\n'
                      f'with voice-file playback into calls.\n\nSIP port: {self.ua.local_port}', parent=self.root))
        mb.add_cascade(label='Help', menu=h)
        self.root.config(menu=mb)

    def _build_ui(self):
        top = ttk.Frame(self.root, padding=(10, 6))
        top.pack(fill='x')
        self.reg_canvas = tk.Canvas(top, width=12, height=12, highlightthickness=0, bg=self.bg)
        self.reg_dot = self.reg_canvas.create_oval(1, 1, 11, 11, fill=GREY, outline='')
        self.reg_canvas.pack(side='left')
        self.reg_var = tk.StringVar(value='Starting…')
        ttk.Label(top, textvariable=self.reg_var, style='Status.TLabel').pack(side='left', padx=6)
        self.info_var = tk.StringVar()
        ttk.Label(top, textvariable=self.info_var, style='Status.TLabel', foreground='#777').pack(side='right')

        self.call_frame = self._build_call_bar(self.root)   # shown only while a call is active

        self.nb = ttk.Notebook(self.root)
        self.nb.pack(fill='both', expand=True, padx=6, pady=(0, 6))
        ext, dial, voice, contacts, history = (ttk.Frame(self.nb, padding=8) for _ in range(5))
        self.nb.add(ext, text='Extensions')
        self.nb.add(dial, text='Dialpad')
        self.nb.add(voice, text='Voice files')
        self.nb.add(contacts, text='Contacts')
        self.nb.add(history, text='History')
        self._build_extensions_tab(ext)
        self._build_dialpad_tab(dial)
        self._build_voice_tab(voice)
        self._build_contacts_tab(contacts)
        self._build_history_tab(history)

    # -- call bar (always on top while in a call) ------------------------------
    def _build_call_bar(self, parent):
        f = ttk.LabelFrame(parent, text='Call', padding=8)
        self.peer_var = tk.StringVar()
        self.state_var = tk.StringVar()
        ttk.Label(f, textvariable=self.peer_var, style='Peer.TLabel').pack(anchor='w')
        ttk.Label(f, textvariable=self.state_var).pack(anchor='w')
        r = ttk.Frame(f)
        r.pack(fill='x', pady=(6, 0))
        btn = dict(font=(FONT, 10, 'bold'), fg='white', activeforeground='white', relief='flat',
                   cursor='hand2', padx=12)
        self.answer_btn = tk.Button(r, text='📞 Answer', bg=GREEN, activebackground=GREEN_D,
                                    command=self.answer, **btn)
        self.hang_btn = tk.Button(r, text='Hang up', bg=RED, activebackground=RED_D,
                                  command=self.on_hangup_button, **btn)
        self.hang_btn.pack(side='left', padx=(0, 6), ipady=2)
        self.mute_var = tk.BooleanVar()
        self.hold_var = tk.BooleanVar()
        self.mute_btn = ttk.Checkbutton(r, text='🎤 Mute', variable=self.mute_var, style='Toolbutton',
                                        command=self.toggle_mute)
        self.hold_btn = ttk.Checkbutton(r, text='⏸ Hold', variable=self.hold_var, style='Toolbutton',
                                        command=self.toggle_hold)
        self.xfer_btn = ttk.Button(r, text='↪ Transfer', command=self.transfer)
        for w in (self.mute_btn, self.hold_btn, self.xfer_btn):
            w.pack(side='left', padx=(0, 4))

        self.voice_bar = ttk.Frame(f)          # shown only when connected
        r = ttk.Frame(self.voice_bar)
        r.pack(fill='x')
        ttk.Label(r, text='Voice file').pack(side='left')
        self.quick_combo = ttk.Combobox(r, state='readonly', width=18)
        self.quick_combo.pack(side='left', fill='x', expand=True, padx=4)
        ttk.Button(r, text='▶', width=3, command=lambda: self.play_file(self._quick_path())).pack(side='left')
        ttk.Button(r, text='■', width=3, command=self.stop_file).pack(side='left', padx=(2, 0))
        self.progress = ttk.Progressbar(self.voice_bar, maximum=1000)
        self.progress.pack(fill='x', pady=(4, 0))
        self.play_var = tk.StringVar()
        ttk.Label(self.voice_bar, textvariable=self.play_var, style='Status.TLabel').pack(anchor='w')
        return f

    # -- extensions tab (online extensions from Asterisk ARI) -------------------
    def _build_extensions_tab(self, f):
        bar = ttk.Frame(f)
        bar.pack(fill='x')
        ttk.Label(bar, text='Search').pack(side='left')
        self.ext_search = tk.StringVar()
        self.ext_search.trace_add('write', lambda *_: self._render_extensions())
        ttk.Entry(bar, textvariable=self.ext_search, font=(FONT, 10)).pack(
            side='left', fill='x', expand=True, padx=4, ipady=2)
        ttk.Button(bar, text='⟳ Refresh', command=self.refresh_directory).pack(side='left')
        self.ext_status = tk.StringVar()
        ttk.Label(f, textvariable=self.ext_status, style='Status.TLabel', foreground='#666').pack(
            anchor='w', pady=(4, 4))
        self.ext_list = ScrollFrame(f)
        self.ext_list.pack(fill='both', expand=True)

    # -- dialpad tab -------------------------------------------------------------
    def _build_dialpad_tab(self, f):
        row = ttk.Frame(f)
        row.pack(fill='x')
        self.num_var = tk.StringVar()
        self.num_entry = ttk.Entry(row, textvariable=self.num_var, font=(FONT, 16), justify='center')
        self.num_entry.pack(side='left', fill='x', expand=True, ipady=2)
        self.num_entry.bind('<Return>', lambda e: self.on_call_button())
        ttk.Button(row, text='⌫', width=3, command=self._backspace).pack(side='left', padx=(4, 0))

        pad = ttk.Frame(f)
        pad.pack(pady=8)
        for i, (d, letters) in enumerate(KEYS):
            b = tk.Button(pad, text=f'{d}\n{letters or " "}', font=(FONT, 12), width=6, height=2,
                          relief='groove', bg='#f7f7f7', activebackground='#e2e2e2', cursor='hand2',
                          command=lambda d=d: self.press_key(d))
            b.grid(row=i // 3, column=i % 3, padx=3, pady=3)

        self.call_btn = tk.Button(f, text='📞  Call', font=(FONT, 11, 'bold'), bg=GREEN, fg='white',
                                  activebackground=GREEN_D, activeforeground='white', relief='flat',
                                  cursor='hand2', command=self.on_call_button)
        self.call_btn.pack(fill='x', padx=40, pady=(2, 0), ipady=4)
        ttk.Label(f, text='During a call the keypad sends DTMF tones.', style='Status.TLabel',
                  foreground='#777').pack(pady=(6, 0))

    # -- voice tab --------------------------------------------------------------
    def _build_voice_tab(self, f):
        lf = ttk.Frame(f)
        lf.pack(fill='both', expand=True)
        sb = ttk.Scrollbar(lf, orient='vertical')
        self.voice_list = tk.Listbox(lf, activestyle='none', font=(FONT, 10), height=8,
                                     yscrollcommand=sb.set, exportselection=False)
        sb.config(command=self.voice_list.yview)
        self.voice_list.pack(side='left', fill='both', expand=True)
        sb.pack(side='left', fill='y')
        self.voice_list.bind('<Double-Button-1>', lambda e: self.play_file(self._selected_voice()))

        r = ttk.Frame(f)
        r.pack(fill='x', pady=(6, 0))
        ttk.Button(r, text='Add…', command=self.add_voice_files).pack(side='left')
        ttk.Button(r, text='Remove', command=self.remove_voice_file).pack(side='left', padx=4)
        ttk.Button(r, text='▲', width=3, command=lambda: self.move_voice(-1)).pack(side='left')
        ttk.Button(r, text='▼', width=3, command=lambda: self.move_voice(1)).pack(side='left', padx=(2, 0))
        r = ttk.Frame(f)
        r.pack(fill='x', pady=(4, 0))
        ttk.Button(r, text='🔊 Preview', command=self.preview_voice).pack(side='left')
        ttk.Button(r, text='▶ Play in call', command=lambda: self.play_file(self._selected_voice())).pack(
            side='left', padx=4)
        ttk.Button(r, text='■ Stop', command=self.stop_all_playback).pack(side='left')

        vo = self.cfg['voice']
        self.v_loop = tk.BooleanVar(value=vo['loop'])
        self.v_mute = tk.BooleanVar(value=vo['mute_mic'])
        self.v_monitor = tk.BooleanVar(value=vo['monitor'])
        self.v_gain = tk.IntVar(value=vo['gain'])
        self.v_autoplay = tk.BooleanVar(value=vo['autoplay'])
        self.v_hangup = tk.BooleanVar(value=vo['hangup_after'])
        self.v_aa = tk.BooleanVar(value=self.cfg['auto_answer'])
        self.v_aa_delay = tk.IntVar(value=self.cfg['auto_answer_delay'])

        opt = ttk.LabelFrame(f, text='Playback options', padding=6)
        opt.pack(fill='x', pady=(8, 0))
        for text, var in (('Loop playback', self.v_loop), ('Mute my microphone while playing', self.v_mute),
                          ('Hear playback locally', self.v_monitor)):
            ttk.Checkbutton(opt, text=text, variable=var, command=self._save_voice_opts).pack(anchor='w')
        g = ttk.Frame(opt)
        g.pack(fill='x', pady=(2, 0))
        ttk.Label(g, text='File volume').pack(side='left')
        self.gain_lbl = ttk.Label(g, text=f'{self.v_gain.get()}%', width=5)
        ttk.Scale(g, from_=0, to=200, variable=self.v_gain, command=self._on_gain).pack(
            side='left', fill='x', expand=True, padx=6)
        self.gain_lbl.pack(side='left')

        auto = ttk.LabelFrame(f, text='Automation', padding=6)
        auto.pack(fill='x', pady=(8, 0))
        r = ttk.Frame(auto)
        r.pack(fill='x')
        ttk.Checkbutton(r, text='Auto-answer incoming calls after', variable=self.v_aa,
                        command=self._save_voice_opts).pack(side='left')
        ttk.Spinbox(r, from_=0, to=60, width=3, textvariable=self.v_aa_delay,
                    command=self._save_voice_opts).pack(side='left', padx=3)
        ttk.Label(r, text='s').pack(side='left')
        ttk.Checkbutton(auto, text='Auto-play this file when a call connects:', variable=self.v_autoplay,
                        command=self._save_voice_opts).pack(anchor='w', pady=(4, 0))
        self.autoplay_combo = ttk.Combobox(auto, state='readonly')
        self.autoplay_combo.pack(fill='x', pady=(2, 0))
        self.autoplay_combo.bind('<<ComboboxSelected>>', lambda e: self._save_voice_opts())
        ttk.Checkbutton(auto, text='Hang up when playback finishes', variable=self.v_hangup,
                        command=self._save_voice_opts).pack(anchor='w', pady=(4, 0))

    # -- contacts / history ----------------------------------------------------
    def _make_tree(self, parent, columns):
        frame = ttk.Frame(parent)
        frame.pack(fill='both', expand=True)
        tree = ttk.Treeview(frame, columns=[c[0] for c in columns], show='headings', selectmode='browse')
        for key, title, width in columns:
            tree.heading(key, text=title)
            tree.column(key, width=width, stretch=True)
        sb = ttk.Scrollbar(frame, orient='vertical', command=tree.yview)
        tree.configure(yscrollcommand=sb.set)
        tree.pack(side='left', fill='both', expand=True)
        sb.pack(side='left', fill='y')
        return tree

    def _build_contacts_tab(self, f):
        self.contact_tree = self._make_tree(f, [('name', 'Name', 150), ('number', 'Number', 130)])
        self.contact_tree.bind('<Double-Button-1>', lambda e: self._call_contact())
        r = ttk.Frame(f)
        r.pack(fill='x', pady=(6, 0))
        ttk.Button(r, text='📞 Call', command=self._call_contact).pack(side='left')
        ttk.Button(r, text='Add', command=self.add_contact).pack(side='left', padx=4)
        ttk.Button(r, text='Edit', command=self.edit_contact).pack(side='left')
        ttk.Button(r, text='Delete', command=self.delete_contact).pack(side='left', padx=4)

    def _build_history_tab(self, f):
        self.hist_tree = self._make_tree(f, [('dir', '', 70), ('who', 'Number', 120),
                                             ('when', 'Time', 110), ('dur', 'Dur.', 50)])
        self.hist_tree.bind('<Double-Button-1>', lambda e: self._call_history())
        r = ttk.Frame(f)
        r.pack(fill='x', pady=(6, 0))
        ttk.Button(r, text='📞 Call back', command=self._call_history).pack(side='left')
        ttk.Button(r, text='Add to contacts', command=self._history_to_contact).pack(side='left', padx=4)
        ttk.Button(r, text='Clear', command=self.clear_history).pack(side='left')

    # ======================================================================
    # SIP listener callbacks (called from network threads)
    # ======================================================================
    def on_log(self, text):
        self.q.put(('log', text))

    def on_reg_state(self, ok, text):
        self.q.put(('reg', ok, text))

    def on_call_state(self, call):
        self.q.put(('call', call))

    def on_incoming_call(self, call):
        self.q.put(('incoming', call))

    def on_dtmf(self, call, digit):
        self.q.put(('log', f'DTMF received: {digit}'))

    def on_media_start(self, call):
        self.engine.start()
        call.rtp.start(self.engine.next_tx_frame, self.engine.push_remote)
        self.q.put(('media', call, list(self.engine.errors)))

    # ======================================================================
    # event loop
    # ======================================================================
    def _poll(self):
        try:
            while True:
                ev = self.q.get_nowait()
                kind = ev[0]
                if kind == 'log':
                    self._append_log(ev[1])
                elif kind == 'reg':
                    self._set_reg(ev[1], ev[2])
                elif kind == 'call':
                    self._on_call_event(ev[1])
                elif kind == 'incoming':
                    self._on_incoming(ev[1])
                elif kind == 'media':
                    if self.tone_active == 'ringback':
                        self._stop_tone()
                    for err in ev[2]:
                        self._append_log('Audio warning: ' + err)
                    if ev[2]:
                        self.play_var.set('Audio device problem – see Phone ▸ SIP log')
                elif kind == 'play_done':
                    self._on_play_done(ev[1])
                elif kind == 'dir':
                    self._on_directory(ev[1], ev[2])
                elif kind == 'fn':
                    ev[1]()
        except queue.Empty:
            pass
        self.root.after(50, self._poll)

    def _tick(self):
        if self.call and self.call.state == 'connected':
            self._refresh_call_ui()
        p = self.engine.player
        if p and p.active:
            self.progress['value'] = p.progress * 1000
            self.play_var.set(f'Playing: {p.name}  ({fmt_dur(p.pos / 8000)} / {fmt_dur(p.duration)})'
                              + ('  [loop]' if p.loop else ''))
        self.root.after(250, self._tick)

    def _set_reg(self, ok, text):
        self.reg_var.set(text)
        color = {True: GREEN, False: RED}.get(ok, ORANGE if 'Regist' in text else GREY)
        self.reg_canvas.itemconfigure(self.reg_dot, fill=color)

    def _start_ua(self):
        acc = dict(self.cfg['account'])
        codecs = [CODEC_PTS[c] for c in self.cfg['codecs'] if c in CODEC_PTS] or [0, 8]
        self._set_reg(None, 'Starting…')

        def run():
            with self._ua_busy:
                try:
                    self.ua.stop()
                    self.ua.start(acc, codecs)
                except Exception as e:
                    self.q.put(('reg', False, f'Error: {e}'))
        threading.Thread(target=run, daemon=True).start()

    # ======================================================================
    # calls
    # ======================================================================
    def press_key(self, d):
        c = self.call
        if c and c.state == 'connected':
            self.ua.send_dtmf(c, d)
            self.dtmf_sent = (self.dtmf_sent + d)[-20:]
            self._refresh_call_ui()
        else:
            self.num_var.set(self.num_var.get() + d)
            self.num_entry.icursor('end')

    def _backspace(self):
        self.num_var.set(self.num_var.get()[:-1])

    def _on_key(self, e):
        if e.widget.winfo_toplevel() is not self.root:
            return
        in_call = self.call is not None and self.call.state == 'connected'
        if e.char and e.char in '0123456789*#':
            if in_call or not isinstance(e.widget, tk.Entry):
                self.press_key(e.char)
        elif e.keysym == 'Escape' and self.call:
            self.on_hangup_button()
        elif e.keysym == 'Return' and self.call and self.call.state == 'incoming':
            self.answer()

    def on_call_button(self):
        c = self.call
        if c and c.state == 'incoming':
            self.answer()
            return
        if c and c.state != 'ended':
            return
        target = self.num_var.get().strip()
        if not target:
            if self.cfg['history']:
                self.num_var.set(self.cfg['history'][0]['number'])
            return
        self.dial(target)

    def dial(self, target):
        if self.call and self.call.state != 'ended':
            messagebox.showinfo(APP_NAME, 'Hang up the current call first.', parent=self.root)
            return
        try:
            call = self.ua.make_call(target)
        except Exception as e:
            messagebox.showerror(APP_NAME, f'Cannot place call:\n{e}', parent=self.root)
            return
        self.call = call
        self.dtmf_sent = ''
        self.num_var.set(target)
        self._refresh_call_ui()

    def answer(self):
        c = self.call
        if c and c.state == 'incoming':
            self._stop_tone()
            self.ua.answer(c)

    def on_hangup_button(self):
        c = self.call
        if not c or c.state == 'ended':
            self.num_var.set('')
            return
        if c.state == 'incoming':
            self.ua.reject(c)
        else:
            self.ua.hangup(c)

    def toggle_mute(self):
        self.engine.mute = self.mute_var.get()

    def toggle_hold(self):
        if self.call and self.call.state == 'connected':
            self.ua.hold(self.call, self.hold_var.get())

    def transfer(self):
        c = self.call
        if not c or c.state != 'connected':
            return
        target = simpledialog.askstring('Transfer', 'Blind transfer to (number or SIP URI):', parent=self.root)
        if target and target.strip():
            self.ua.transfer(c, target.strip())
            self.last_end_text = f'Transferring to {target.strip()}…'

    def _on_incoming(self, call):
        if self.call and self.call is not call and self.call.state != 'ended':
            return
        self.call = call
        self.dtmf_sent = ''
        self._start_tone('ring')
        self._refresh_call_ui()
        try:
            self.root.deiconify()
            self.root.lift()
            self.root.attributes('-topmost', True)
            self.root.after(600, lambda: self.root.attributes('-topmost', False))
            self.root.focus_force()
        except tk.TclError:
            pass
        if self.cfg['auto_answer']:
            delay = max(0, int(self.cfg.get('auto_answer_delay') or 0))
            self.root.after(delay * 1000, lambda: self.call is call and self.answer())

    def _on_call_event(self, call):
        if call.state == 'ended':
            if self.call is call:
                self._finish_call(call)
            return
        if self.call is not None and self.call is not call and self.call.state != 'ended':
            return
        self.call = call
        if call.state == 'ringing' and call.direction == 'out' and not call.media_started:
            self._start_tone('ringback')
        elif call.state == 'connected':
            self._stop_tone()
            if not getattr(call, '_ui_connected', False):
                call._ui_connected = True
                self._on_connected(call)
        self._refresh_call_ui()

    def _on_connected(self, call):
        self.mute_var.set(False)
        self.engine.mute = False
        vo = self.cfg['voice']
        if vo['autoplay'] and vo['autoplay_file']:
            self.play_file(vo['autoplay_file'])

    def _finish_call(self, call):
        self._stop_tone()
        self.engine.stop_player()
        self.engine.stop()
        self._add_history(call)
        self.call = None
        self.mute_var.set(False)
        self.hold_var.set(False)
        self.progress['value'] = 0
        self.play_var.set('')
        dur = f' ({fmt_dur(call.ended_at - call.connected_at)})' if call.connected_at else ''
        self.last_end_text = f'{call.end_reason}{dur}'
        self._refresh_call_ui()

    @staticmethod
    def _show(widget, visible, **pack_opts):
        packed = widget.winfo_manager() != ''
        if visible and not packed:
            widget.pack(**pack_opts)
        elif not visible and packed:
            widget.pack_forget()

    def _refresh_call_ui(self):
        c = self.call
        active = c is not None and c.state != 'ended'
        self._show(self.call_frame, active, fill='x', padx=6, pady=(0, 6), before=self.nb)
        self.info_var.set('' if active or not self.last_end_text else f'Last call: {self.last_end_text}')
        self.call_btn.config(state='disabled' if active else 'normal')
        if not active:
            self.num_entry.state(['!readonly'])
            return
        peer = c.remote_number or c.dialed
        name = next((x['name'] for x in self.cfg['contacts'] if x['number'] in (peer, c.dialed)), '') or c.remote_name
        self.peer_var.set(f'{name}  <{peer}>' if name and name != peer else peer)
        if c.state == 'connected':
            dur = fmt_dur(time.time() - (c.connected_at or time.time()))
            text = ('On hold' if c.on_hold else 'Connected') + f'  {dur}'
            if c.held_by_remote:
                text += '  (held by remote)'
            if c.codec_name:
                text += f'  · {c.codec_name}'
            if self.dtmf_sent:
                text += f'\nDTMF: {self.dtmf_sent}'
        else:
            text = {'calling': 'Calling…', 'ringing': 'Ringing…',
                    'incoming': 'Incoming call…'}.get(c.state, c.state)
        self.state_var.set(text)
        incoming = c.state == 'incoming'
        connected = c.state == 'connected'
        self._show(self.answer_btn, incoming, side='left', padx=(0, 6), ipady=2, before=self.hang_btn)
        self.hang_btn.config(text='Reject' if incoming else ('Hang up' if connected else 'Cancel'))
        for w in (self.mute_btn, self.hold_btn, self.xfer_btn):
            w.state(['!disabled'] if connected else ['disabled'])
        self._show(self.voice_bar, connected, fill='x', pady=(8, 0))
        self.num_entry.state(['readonly'] if connected else ['!readonly'])

    # ======================================================================
    # extensions directory (Asterisk ARI)
    # ======================================================================
    def _directory_loop(self):
        while not self._closing:
            d = self.cfg['directory']
            if d.get('url'):
                try:
                    entries = AriClient(d['url'], d.get('username', ''), d.get('password', '')).endpoints()
                    self.q.put(('dir', entries, None))
                except AriError as e:
                    self.q.put(('dir', None, str(e)))
                except Exception as e:
                    self.q.put(('dir', None, f'Directory error: {e}'))
            try:
                interval = max(3, int(d.get('interval') or 10))
            except (TypeError, ValueError):
                interval = 10
            self.dir_wakeup.wait(interval)
            self.dir_wakeup.clear()

    def refresh_directory(self):
        if self.cfg['directory'].get('url'):
            self.ext_status.set('Refreshing…')
        self.dir_wakeup.set()

    def _on_directory(self, entries, error):
        if entries is not None:
            self.dir_entries = entries
            self.dir_error = ''
            self.dir_updated = time.strftime('%H:%M:%S')
        else:
            self.dir_error = error
        self._render_extensions()

    def _online_extensions(self):
        own = (self.cfg['account'].get('username') or '').strip()
        names = {c['number']: c['name'] for c in self.cfg['contacts']}
        items = [dict(e, name=names.get(e['ext'], '')) for e in self.dir_entries
                 if e['state'] == 'online' and e['ext'] != own]
        items.sort(key=lambda e: _natural_key(e['ext']))
        return items

    def _render_extensions(self):
        if not hasattr(self, 'ext_list'):
            return
        configured = bool(self.cfg['directory'].get('url'))
        online = self._online_extensions()
        q = self.ext_search.get().strip().lower()
        items = [e for e in online if q in e['ext'].lower() or q in e['name'].lower()] if q else online

        if not configured:
            self.ext_status.set('Directory server not configured')
        elif self.dir_error:
            when = f' (last update {self.dir_updated})' if self.dir_updated else ''
            self.ext_status.set(f'⚠ {self.dir_error}{when}')
        elif self.dir_updated:
            shown = f'{len(items)} of {len(online)}' if q else f'{len(online)}'
            self.ext_status.set(f'{shown} online · updated {self.dir_updated} · '
                                f'every {self.cfg["directory"].get("interval", 10)}s')
        else:
            self.ext_status.set('Loading…')

        sig = (configured, bool(self.dir_error) and not self.dir_entries, q,
               tuple((e['ext'], e['name'], e['in_call']) for e in items[:MAX_ROWS]), len(items))
        if sig == self.dir_sig:
            return
        self.dir_sig = sig
        lst = self.ext_list
        lst.clear()
        if not configured:
            box = tk.Frame(lst.inner, bg=ROW_BG, pady=30)
            box.pack(fill='x')
            tk.Label(box, text='See which extensions are online', font=(FONT, 11, 'bold'), bg=ROW_BG).pack()
            tk.Label(box, text='The list is read from your Asterisk server through ARI\n'
                               '(the same server your SIP account registers to).',
                     fg='#666', bg=ROW_BG, justify='center').pack(pady=(4, 10))
            ttk.Button(box, text='Set up directory server…', command=self.directory_dialog).pack()
            return
        if not items:
            msg = ('Cannot load extensions.' if self.dir_error and not self.dir_entries
                   else 'No matching online extensions.' if q
                   else 'No other extensions are online.' if self.dir_updated else 'Loading…')
            tk.Label(lst.inner, text=msg, fg='#666', bg=ROW_BG, pady=30).pack(fill='x')
            return
        for e in items[:MAX_ROWS]:
            self._ext_row(lst.inner, e)
        if len(items) > MAX_ROWS:
            tk.Label(lst.inner, text=f'Showing {MAX_ROWS} of {len(items)} – type to search',
                     fg='#666', bg=ROW_BG, pady=8).pack(fill='x')

    def _ext_row(self, parent, e):
        ext = e['ext']
        row = tk.Frame(parent, bg=ROW_BG, padx=10, pady=6)
        row.pack(fill='x')
        tk.Frame(parent, height=1, bg='#ececec').pack(fill='x')
        dot = tk.Label(row, text='●', font=(FONT, 12), bg=ROW_BG, fg=ORANGE if e['in_call'] else GREEN)
        dot.pack(side='left')
        txt = tk.Frame(row, bg=ROW_BG)
        txt.pack(side='left', fill='x', expand=True, padx=(8, 0))
        title = tk.Label(txt, text=e['name'] or ext, font=(FONT, 11, 'bold'), bg=ROW_BG, anchor='w')
        title.pack(fill='x')
        status = 'In a call' if e['in_call'] else 'Online'
        sub = tk.Label(txt, text=f'{ext} · {status}' if e['name'] else status, font=(FONT, 9),
                       fg='#777', bg=ROW_BG, anchor='w')
        sub.pack(fill='x')
        tk.Button(row, text='📞 Call', font=(FONT, 9, 'bold'), bg=GREEN, fg='white', activebackground=GREEN_D,
                  activeforeground='white', relief='flat', cursor='hand2', padx=12, pady=2,
                  command=lambda: self.dial(ext)).pack(side='right')
        for w in (row, dot, txt, title, sub):
            w.bind('<Double-Button-1>', lambda _e: self.dial(ext))

    def directory_dialog(self):
        d = self.cfg['directory']
        dlg = tk.Toplevel(self.root)
        dlg.title('Directory server (Asterisk ARI)')
        dlg.transient(self.root)
        dlg.resizable(False, False)
        frm = ttk.Frame(dlg, padding=14)
        frm.pack()
        acc = self.cfg['account']
        server = default_url(acc.get('proxy') or acc.get('domain')).replace('http://', '').replace(':8088', '')
        url_v = tk.StringVar(value=d.get('url') or (f'https://{server}' if server else ''))
        user_v = tk.StringVar(value=d.get('username', ''))
        pw_v = tk.StringVar(value=d.get('password', ''))
        int_v = tk.StringVar(value=str(d.get('interval', 10)))
        rows = [('ARI URL', url_v, ''), ('ARI username', user_v, ''), ('ARI password', pw_v, '•'),
                ('Refresh every (s)', int_v, '')]
        for r, (label, var, show) in enumerate(rows):
            ttk.Label(frm, text=label).grid(row=r, column=0, sticky='w', pady=3, padx=(0, 10))
            ttk.Entry(frm, textvariable=var, width=34, show=show).grid(row=r, column=1, pady=3)
        ttk.Label(frm, text='Use the HTTPS address printed by server/setup_ari_directory.sh, '
                            'e.g. https://pbx.example.com. A direct http://server:8088 address only '
                            'works on a LAN where port 8088 is open.',
                  wraplength=360, foreground='#666').grid(row=4, column=0, columnspan=2, sticky='w', pady=(8, 0))
        result_v = tk.StringVar()
        ttk.Label(frm, textvariable=result_v, wraplength=360).grid(row=5, column=0, columnspan=2, sticky='w',
                                                                   pady=(6, 0))

        def test():
            result_v.set('Testing…')
            url, user, pw = url_v.get(), user_v.get(), pw_v.get()

            def run():
                try:
                    eps = AriClient(url, user, pw).endpoints()
                    on = sum(1 for e in eps if e['state'] == 'online')
                    msg = f'✔ Connected – {on} online of {len(eps)} SIP endpoints'
                except AriError as e:
                    msg = f'✖ {e}'
                self.q.put(('fn', lambda: dlg.winfo_exists() and result_v.set(msg)))
            threading.Thread(target=run, daemon=True).start()

        def save():
            try:
                interval = max(3, int(int_v.get()))
            except ValueError:
                messagebox.showerror(APP_NAME, 'Refresh interval must be a number.', parent=dlg)
                return
            d.update(url=url_v.get().strip(), username=user_v.get().strip(), password=pw_v.get(),
                     interval=interval)
            self._save()
            dlg.destroy()
            self.dir_entries, self.dir_error, self.dir_updated, self.dir_sig = [], '', None, None
            self._render_extensions()
            self.refresh_directory()

        b = ttk.Frame(frm)
        b.grid(row=6, column=0, columnspan=2, sticky='e', pady=(12, 0))
        ttk.Button(b, text='Test connection', command=test).pack(side='left', padx=(0, 12))
        ttk.Button(b, text='Save', command=save).pack(side='left', padx=4)
        ttk.Button(b, text='Cancel', command=dlg.destroy).pack(side='left')
        dlg.bind('<Escape>', lambda e: dlg.destroy())
        dlg.grab_set()

    # -- tones -------------------------------------------------------------------
    def _start_tone(self, kind):
        if self.tone_active == kind:
            return
        self._stop_tone()
        buf = None
        if kind == 'ring':
            path = self.cfg['audio'].get('ringtone')
            if path:
                try:
                    import numpy as np
                    buf = np.concatenate([self._load_audio(path).astype('float32'), np.zeros(8000, 'float32')])
                except Exception:
                    buf = None
            if buf is None:
                buf = make_ringtone()
        else:
            buf = make_ringback()
        play_buffer(buf, self.engine.output_device, loop=True)
        self.tone_active = kind

    def _stop_tone(self):
        if self.tone_active:
            stop_buffer()
            self.tone_active = None

    # ======================================================================
    # voice files
    # ======================================================================
    def _voice_files(self):
        return self.cfg['voice']['files']

    def _load_audio(self, path):
        st = os.stat(path)
        key = (path, st.st_mtime, st.st_size)
        if key not in self.audio_cache:
            self.audio_cache[key] = load_audio_8k(path)
        return self.audio_cache[key]

    def _refresh_voice_lists(self):
        files = self._voice_files()
        self.voice_list.delete(0, 'end')
        names = []
        for p in files:
            name = os.path.basename(p)
            label = name
            try:
                label = f'{name}   ({fmt_dur(len(self._load_audio(p)) / 8000)})'
            except Exception:
                label = f'{name}   (missing / unreadable)'
            self.voice_list.insert('end', label)
            names.append(name)
        self.quick_combo['values'] = names
        self.autoplay_combo['values'] = names
        if names and self.quick_combo.current() < 0:
            self.quick_combo.current(0)
        if not names:
            self.quick_combo.set('')
        ap = self.cfg['voice']['autoplay_file']
        if ap in files:
            self.autoplay_combo.current(files.index(ap))
        else:
            self.autoplay_combo.set('')

    def _selected_voice(self):
        sel = self.voice_list.curselection()
        files = self._voice_files()
        if sel and sel[0] < len(files):
            return files[sel[0]]
        return None

    def _quick_path(self):
        i = self.quick_combo.current()
        files = self._voice_files()
        return files[i] if 0 <= i < len(files) else None

    def add_voice_files(self):
        paths = filedialog.askopenfilenames(parent=self.root, title='Add voice files', filetypes=FILE_TYPES)
        bad = []
        for p in paths:
            p = os.path.normpath(p)
            try:
                self._load_audio(p)
            except Exception as e:
                bad.append(f'{os.path.basename(p)}: {e}')
                continue
            if p not in self._voice_files():
                self._voice_files().append(p)
        if bad:
            messagebox.showwarning(APP_NAME, 'Could not load:\n' + '\n'.join(bad), parent=self.root)
        self._save()
        self._refresh_voice_lists()

    def remove_voice_file(self):
        p = self._selected_voice()
        if not p:
            return
        self._voice_files().remove(p)
        if self.cfg['voice']['autoplay_file'] == p:
            self.cfg['voice']['autoplay_file'] = ''
        self._save()
        self._refresh_voice_lists()

    def move_voice(self, delta):
        sel = self.voice_list.curselection()
        files = self._voice_files()
        if not sel:
            return
        i, j = sel[0], sel[0] + delta
        if 0 <= j < len(files):
            files[i], files[j] = files[j], files[i]
            self._save()
            self._refresh_voice_lists()
            self.voice_list.selection_set(j)

    def preview_voice(self):
        p = self._selected_voice()
        if not p:
            messagebox.showinfo(APP_NAME, 'Select a voice file first.', parent=self.root)
            return
        try:
            samples = self._load_audio(p)
        except Exception as e:
            messagebox.showerror(APP_NAME, f'Cannot load file:\n{e}', parent=self.root)
            return
        self._stop_tone()
        play_buffer(samples.astype('float32') * (self.v_gain.get() / 100.0), self.engine.output_device)

    def play_file(self, path):
        if not path:
            messagebox.showinfo(APP_NAME, 'Select a voice file first (add files on the "Voice files" tab).',
                                parent=self.root)
            return
        c = self.call
        if not c or c.state != 'connected':
            messagebox.showinfo(APP_NAME, 'There is no connected call.\nUse "Preview" to listen locally.',
                                parent=self.root)
            return
        try:
            samples = self._load_audio(path)
        except Exception as e:
            messagebox.showerror(APP_NAME, f'Cannot load file:\n{e}', parent=self.root)
            return
        vo = self.cfg['voice']
        self.engine.stop_player()
        self.engine.mute_mic_while_playing = vo['mute_mic']
        self.engine.monitor_file = vo['monitor']
        self.engine.player = FilePlayer(samples, os.path.basename(path), loop=vo['loop'],
                                        gain=vo['gain'] / 100.0,
                                        on_done=lambda: self.q.put(('play_done', path)))
        self._append_log(f'Playing voice file into call: {path}')

    def stop_file(self):
        self.engine.stop_player()
        self.progress['value'] = 0
        self.play_var.set('Playback stopped')

    def stop_all_playback(self):
        self.stop_file()
        stop_buffer()
        self.tone_active = None

    def _on_play_done(self, path):
        self.progress['value'] = 1000
        self.play_var.set(f'Finished: {os.path.basename(path)}')
        if self.cfg['voice']['hangup_after'] and self.call and self.call.state == 'connected':
            self.root.after(300, lambda: self.call and self.ua.hangup(self.call))

    def _on_gain(self, _value=None):
        self.gain_lbl.config(text=f'{int(float(self.v_gain.get()))}%')
        self.cfg['voice']['gain'] = int(float(self.v_gain.get()))
        if self.engine.player:
            self.engine.player.gain = self.cfg['voice']['gain'] / 100.0
        if not hasattr(self, '_gain_save_pending'):
            self._gain_save_pending = True
            self.root.after(800, self._flush_gain)

    def _flush_gain(self):
        del self._gain_save_pending
        self._save()

    def _save_voice_opts(self):
        vo = self.cfg['voice']
        vo['loop'] = self.v_loop.get()
        vo['mute_mic'] = self.v_mute.get()
        vo['monitor'] = self.v_monitor.get()
        vo['autoplay'] = self.v_autoplay.get()
        vo['hangup_after'] = self.v_hangup.get()
        i = self.autoplay_combo.current()
        files = self._voice_files()
        vo['autoplay_file'] = files[i] if 0 <= i < len(files) else ''
        self.cfg['auto_answer'] = self.v_aa.get()
        try:
            self.cfg['auto_answer_delay'] = int(self.v_aa_delay.get())
        except (tk.TclError, ValueError):
            pass
        p = self.engine.player
        if p:
            p.loop = vo['loop']
        self.engine.mute_mic_while_playing = vo['mute_mic']
        self.engine.monitor_file = vo['monitor']
        self._save()

    # ======================================================================
    # contacts / history
    # ======================================================================
    def _refresh_contacts(self):
        self.contact_tree.delete(*self.contact_tree.get_children())
        for i, c in sorted(enumerate(self.cfg['contacts']), key=lambda ic: ic[1]['name'].lower()):
            self.contact_tree.insert('', 'end', iid=str(i), values=(c['name'], c['number']))
        self._render_extensions()   # contact names label extensions

    def _contact_form(self, title, name='', number=''):
        dlg = tk.Toplevel(self.root)
        dlg.title(title)
        dlg.transient(self.root)
        dlg.resizable(False, False)
        frm = ttk.Frame(dlg, padding=12)
        frm.pack()
        nv, numv = tk.StringVar(value=name), tk.StringVar(value=number)
        ttk.Label(frm, text='Name').grid(row=0, column=0, sticky='w', pady=3)
        e = ttk.Entry(frm, textvariable=nv, width=28)
        e.grid(row=0, column=1, pady=3)
        ttk.Label(frm, text='Number / SIP URI').grid(row=1, column=0, sticky='w', pady=3, padx=(0, 8))
        ttk.Entry(frm, textvariable=numv, width=28).grid(row=1, column=1, pady=3)
        result = {}

        def ok(_e=None):
            if numv.get().strip():
                result.update(name=nv.get().strip() or numv.get().strip(), number=numv.get().strip())
                dlg.destroy()
        b = ttk.Frame(frm)
        b.grid(row=2, column=0, columnspan=2, pady=(10, 0), sticky='e')
        ttk.Button(b, text='Save', command=ok).pack(side='left', padx=4)
        ttk.Button(b, text='Cancel', command=dlg.destroy).pack(side='left')
        dlg.bind('<Return>', ok)
        dlg.bind('<Escape>', lambda e: dlg.destroy())
        e.focus_set()
        dlg.grab_set()
        self.root.wait_window(dlg)
        return result or None

    def add_contact(self, number=''):
        r = self._contact_form('Add contact', number=number)
        if r:
            self.cfg['contacts'].append(r)
            self._save()
            self._refresh_contacts()

    def _sel_contact(self):
        sel = self.contact_tree.selection()
        return int(sel[0]) if sel else None

    def edit_contact(self):
        i = self._sel_contact()
        if i is None:
            return
        c = self.cfg['contacts'][i]
        r = self._contact_form('Edit contact', c['name'], c['number'])
        if r:
            self.cfg['contacts'][i] = r
            self._save()
            self._refresh_contacts()

    def delete_contact(self):
        i = self._sel_contact()
        if i is None:
            return
        c = self.cfg['contacts'][i]
        if messagebox.askyesno(APP_NAME, f'Delete contact "{c["name"]}"?', parent=self.root):
            del self.cfg['contacts'][i]
            self._save()
            self._refresh_contacts()

    def _call_contact(self):
        i = self._sel_contact()
        if i is not None:
            self.dial(self.cfg['contacts'][i]['number'])

    def _add_history(self, call):
        d = 'out' if call.direction == 'out' else ('in' if call.connected_at else 'missed')
        self.cfg['history'].insert(0, {
            'dir': d,
            'number': call.dialed or call.remote_number,
            'name': call.remote_name,
            'time': time.strftime('%d-%m-%Y %H:%M', time.localtime(call.created)),
            'duration': int(call.ended_at - call.connected_at) if call.connected_at else 0,
            'reason': call.end_reason,
        })
        del self.cfg['history'][200:]
        self._save()
        self._refresh_history()

    def _refresh_history(self):
        self.hist_tree.delete(*self.hist_tree.get_children())
        names = {c['number']: c['name'] for c in self.cfg['contacts']}
        for i, h in enumerate(self.cfg['history']):
            who = names.get(h['number']) or h.get('name') or h['number']
            self.hist_tree.insert('', 'end', iid=str(i), values=(
                DIR_ICON.get(h['dir'], h['dir']), who, h['time'],
                fmt_dur(h['duration']) if h['duration'] else '–'))

    def _sel_history(self):
        sel = self.hist_tree.selection()
        return self.cfg['history'][int(sel[0])] if sel else None

    def _call_history(self):
        h = self._sel_history()
        if h:
            self.dial(h['number'])

    def _history_to_contact(self):
        h = self._sel_history()
        if h:
            self.add_contact(h['number'])

    def clear_history(self):
        if self.cfg['history'] and messagebox.askyesno(APP_NAME, 'Clear call history?', parent=self.root):
            self.cfg['history'].clear()
            self._save()
            self._refresh_history()

    # ======================================================================
    # settings dialogs
    # ======================================================================
    def account_dialog(self):
        acc = self.cfg['account']
        dlg = tk.Toplevel(self.root)
        dlg.title('SIP account')
        dlg.transient(self.root)
        dlg.resizable(False, False)
        frm = ttk.Frame(dlg, padding=14)
        frm.pack()
        fields = [('Display name', 'display_name', False), ('SIP server / domain', 'domain', False),
                  ('Outbound proxy (optional)', 'proxy', False), ('Username / extension', 'username', False),
                  ('Auth ID (optional)', 'auth_user', False), ('Password', 'password', True),
                  ('Registration expiry (s)', 'expires', False), ('Local SIP port', 'local_port', False)]
        vars_ = {}
        for r, (label, key, secret) in enumerate(fields):
            ttk.Label(frm, text=label).grid(row=r, column=0, sticky='w', pady=3, padx=(0, 10))
            v = tk.StringVar(value=str(acc.get(key, '')))
            ttk.Entry(frm, textvariable=v, width=30, show='•' if secret else '').grid(row=r, column=1, pady=3)
            vars_[key] = v
        r = len(fields)
        reg_v = tk.BooleanVar(value=acc.get('register', True))
        nat_v = tk.BooleanVar(value=acc.get('nat', True))
        ttk.Checkbutton(frm, text='Register with server', variable=reg_v).grid(row=r, column=1, sticky='w')
        ttk.Checkbutton(frm, text='NAT traversal (use rport public address)', variable=nat_v).grid(
            row=r + 1, column=1, sticky='w')
        ttk.Label(frm, text='Codecs').grid(row=r + 2, column=0, sticky='w', pady=(6, 0))
        codec_opts = ['PCMU, PCMA', 'PCMA, PCMU', 'PCMU', 'PCMA']
        codec_v = tk.StringVar(value=', '.join(self.cfg['codecs']))
        ttk.Combobox(frm, textvariable=codec_v, values=codec_opts, state='readonly', width=27).grid(
            row=r + 2, column=1, pady=(6, 0))
        ttk.Label(frm, text='Leave the server empty to make direct IP calls (e.g. 192.168.1.20 or user@ip).',
                  wraplength=330, foreground='#666').grid(row=r + 3, column=0, columnspan=2, sticky='w', pady=(8, 0))

        def save():
            new = {k: v.get().strip() for k, v in vars_.items()}
            new['password'] = vars_['password'].get()
            try:
                new['expires'] = int(new['expires'] or 300)
                new['local_port'] = int(new['local_port'] or 5060)
            except ValueError:
                messagebox.showerror(APP_NAME, 'Expiry and port must be numbers.', parent=dlg)
                return
            new['register'] = reg_v.get()
            new['nat'] = nat_v.get()
            acc.update(new)
            self.cfg['codecs'] = [c.strip() for c in codec_v.get().split(',') if c.strip()]
            self._save()
            dlg.destroy()
            self._start_ua()
            self._render_extensions()

        b = ttk.Frame(frm)
        b.grid(row=r + 4, column=0, columnspan=2, sticky='e', pady=(12, 0))
        ttk.Button(b, text='Save', command=save).pack(side='left', padx=4)
        ttk.Button(b, text='Cancel', command=dlg.destroy).pack(side='left')
        dlg.bind('<Escape>', lambda e: dlg.destroy())
        dlg.grab_set()

    def audio_dialog(self):
        au = self.cfg['audio']
        ins, outs = list_devices()
        default = '(System default)'
        dlg = tk.Toplevel(self.root)
        dlg.title('Audio devices')
        dlg.transient(self.root)
        dlg.resizable(False, False)
        frm = ttk.Frame(dlg, padding=14)
        frm.pack()
        in_v = tk.StringVar(value=au['input'] or default)
        out_v = tk.StringVar(value=au['output'] or default)
        ring_v = tk.StringVar(value=au['ringtone'])
        mic_v = tk.IntVar(value=au['mic_gain'])
        spk_v = tk.IntVar(value=au['spk_gain'])
        ttk.Label(frm, text='Microphone').grid(row=0, column=0, sticky='w', pady=3, padx=(0, 10))
        ttk.Combobox(frm, textvariable=in_v, values=[default] + ins, state='readonly', width=36).grid(
            row=0, column=1, columnspan=2, pady=3)
        ttk.Label(frm, text='Speaker').grid(row=1, column=0, sticky='w', pady=3)
        ttk.Combobox(frm, textvariable=out_v, values=[default] + outs, state='readonly', width=36).grid(
            row=1, column=1, columnspan=2, pady=3)
        ttk.Label(frm, text='Mic volume').grid(row=2, column=0, sticky='w', pady=3)
        ttk.Scale(frm, from_=0, to=200, variable=mic_v).grid(row=2, column=1, columnspan=2, sticky='we')
        ttk.Label(frm, text='Speaker volume').grid(row=3, column=0, sticky='w', pady=3)
        ttk.Scale(frm, from_=0, to=200, variable=spk_v).grid(row=3, column=1, columnspan=2, sticky='we')
        ttk.Label(frm, text='Ringtone file').grid(row=4, column=0, sticky='w', pady=3)
        ttk.Entry(frm, textvariable=ring_v, width=28).grid(row=4, column=1, pady=3)

        def browse():
            p = filedialog.askopenfilename(parent=dlg, filetypes=FILE_TYPES)
            if p:
                ring_v.set(os.path.normpath(p))
        ttk.Button(frm, text='…', width=3, command=browse).grid(row=4, column=2, padx=(4, 0))
        ttk.Label(frm, text='Leave ringtone empty for the built-in ring.', foreground='#666').grid(
            row=5, column=1, columnspan=2, sticky='w')

        def save():
            au['input'] = '' if in_v.get() == default else in_v.get()
            au['output'] = '' if out_v.get() == default else out_v.get()
            au['ringtone'] = ring_v.get().strip()
            au['mic_gain'] = int(float(mic_v.get()))
            au['spk_gain'] = int(float(spk_v.get()))
            self._apply_audio_cfg()
            self._save()
            dlg.destroy()

        b = ttk.Frame(frm)
        b.grid(row=6, column=0, columnspan=3, sticky='e', pady=(12, 0))
        ttk.Button(b, text='Save', command=save).pack(side='left', padx=4)
        ttk.Button(b, text='Cancel', command=dlg.destroy).pack(side='left')
        dlg.bind('<Escape>', lambda e: dlg.destroy())
        dlg.grab_set()

    def _apply_audio_cfg(self):
        au = self.cfg['audio']
        self.engine.input_device = resolve_device(au['input'], 'input')
        self.engine.output_device = resolve_device(au['output'], 'output')
        self.engine.mic_gain = au['mic_gain'] / 100.0
        self.engine.spk_gain = au['spk_gain'] / 100.0

    # ======================================================================
    # SIP log window
    # ======================================================================
    def _append_log(self, text):
        line = f'[{time.strftime("%H:%M:%S")}] {text.rstrip()}\n'
        self.sip_log.append(line)
        if self.log_text is not None:
            try:
                self.log_text.insert('end', line + '\n')
                self.log_text.see('end')
            except tk.TclError:
                self.log_text = None

    def show_log(self):
        win = tk.Toplevel(self.root)
        win.title(f'{APP_NAME} – SIP log')
        win.geometry('760x520')
        frm = ttk.Frame(win)
        frm.pack(fill='both', expand=True)
        txt = tk.Text(frm, font=('Consolas', 9), wrap='none')
        sb = ttk.Scrollbar(frm, orient='vertical', command=txt.yview)
        txt.configure(yscrollcommand=sb.set)
        txt.pack(side='left', fill='both', expand=True)
        sb.pack(side='left', fill='y')
        txt.insert('end', '\n'.join(self.sip_log))
        txt.see('end')

        def clear():
            self.sip_log.clear()
            txt.delete('1.0', 'end')
        ttk.Button(win, text='Clear', command=clear).pack(anchor='e', padx=6, pady=4)
        self.log_text = txt

        def closed():
            self.log_text = None
            win.destroy()
        win.protocol('WM_DELETE_WINDOW', closed)

    # ======================================================================
    # misc
    # ======================================================================
    def _save(self):
        try:
            config.save(self.cfg)
        except OSError as e:
            self._append_log(f'Cannot save settings: {e}')

    def on_close(self):
        self._closing = True
        self.dir_wakeup.set()
        try:
            self.cfg['geometry'] = self.root.geometry()
        except tk.TclError:
            pass
        self._save()
        self._stop_tone()
        self.engine.stop_player()
        try:
            self.ua.stop()
        except Exception:
            pass
        self.engine.stop()
        self.root.destroy()


def main():
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass
    PhoneApp().run()
