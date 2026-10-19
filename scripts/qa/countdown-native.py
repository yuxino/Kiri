"""Native acceptance on an isolated Windows CI desktop; capture protection stays on."""
import ctypes,hashlib,json,os,re,subprocess,time
from ctypes import wintypes
from pathlib import Path
from pywinauto import Desktop,keyboard,mouse
from PIL import ImageGrab
import win32com.client
from windows_crash_report import configure_crash_capture,collect_crash_details

if os.environ.get('GITHUB_ACTIONS')!='true':raise SystemExit('Use an isolated CI desktop')
OUT=Path('countdown-native-review');OUT.mkdir(exist_ok=True)
report={'success':False,'native':True,'checks':[]}
configure_crash_capture(OUT)
installed_exe=os.environ.get('KIRI_QA_INSTALLED_EXE')
app=Path(installed_exe or 'src-tauri/target/release/kiri.exe').resolve()
report['candidate']={'path':str(app),'source':'installed' if installed_exe else 'compiled fallback',
    'sha256':hashlib.sha256(app.read_bytes()).hexdigest()}
proc=subprocess.Popen([str(app)]);pid=proc.pid
desktop=Desktop(backend='uia');source_window=None
user32=ctypes.windll.user32
# Keep hit testing, screenshots and HWND rectangles in the same physical units.
# pywinauto may already have set process awareness; a thread override is explicit.
user32.SetThreadDpiAwarenessContext.argtypes=[wintypes.HANDLE]
user32.SetThreadDpiAwarenessContext.restype=wintypes.HANDLE
user32.SetThreadDpiAwarenessContext(wintypes.HANDLE(-4))
user32.GetWindowRect.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.RECT)]
user32.GetWindowDisplayAffinity.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.DWORD)]
user32.IsWindow.argtypes=[wintypes.HWND]
user32.IsWindowVisible.argtypes=[wintypes.HWND]
user32.IsZoomed.argtypes=[wintypes.HWND]
user32.IsZoomed.restype=wintypes.BOOL
user32.GetForegroundWindow.restype=wintypes.HWND
user32.GetAncestor.argtypes=[wintypes.HWND,wintypes.UINT]
user32.GetAncestor.restype=wintypes.HWND
user32.WindowFromPoint.argtypes=[wintypes.POINT]
user32.WindowFromPoint.restype=wintypes.HWND
user32.MonitorFromWindow.argtypes=[wintypes.HWND,wintypes.DWORD]
user32.MonitorFromWindow.restype=wintypes.HANDLE
user32.GetDpiForWindow.argtypes=[wintypes.HWND]
user32.GetDpiForWindow.restype=wintypes.UINT
user32.GetWindowTextW.argtypes=[wintypes.HWND,wintypes.LPWSTR,ctypes.c_int]
user32.GetWindowTextW.restype=ctypes.c_int
get_style=user32.GetWindowLongPtrW
get_style.argtypes=[wintypes.HWND,ctypes.c_int]
get_style.restype=ctypes.c_ssize_t
class MonitorInfo(ctypes.Structure):
 _fields_=[('size',wintypes.DWORD),('monitor',wintypes.RECT),('work',wintypes.RECT),('flags',wintypes.DWORD)]
user32.GetMonitorInfoW.argtypes=[wintypes.HANDLE,ctypes.POINTER(MonitorInfo)]
ENUM_WINDOWS=ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
user32.EnumWindows.argtypes=[ENUM_WINDOWS,wintypes.LPARAM]
width=user32.GetSystemMetrics(0);height=user32.GetSystemMetrics(1)
def rectangle(rect):return [rect.left,rect.top,rect.right,rect.bottom]
def window_rect(hwnd):
 rect=wintypes.RECT()
 if not user32.GetWindowRect(hwnd,ctypes.byref(rect)):raise RuntimeError('Could not read native window rectangle')
 return rectangle(rect)
def capture_affinity(hwnd):
 affinity=wintypes.DWORD()
 if not user32.GetWindowDisplayAffinity(hwnd,ctypes.byref(affinity)):raise RuntimeError('Could not read native capture protection')
 return affinity.value
def native_windows():
 result=[]
 @ENUM_WINDOWS
 def visit(hwnd,_):
  owner=wintypes.DWORD();user32.GetWindowThreadProcessId(hwnd,ctypes.byref(owner))
  if owner.value==pid and user32.IsWindowVisible(hwnd):
   result.append({'hwnd':int(hwnd),'rect':window_rect(hwnd),'extended_style':int(get_style(hwnd,-20))})
  return True
 if not user32.EnumWindows(visit,0):raise RuntimeError('Could not enumerate native windows')
 return result
def hit_evidence(hwnd):
 owner=wintypes.DWORD();user32.GetWindowThreadProcessId(hwnd,ctypes.byref(owner))
 title=ctypes.create_unicode_buffer(512);user32.GetWindowTextW(hwnd,title,len(title))
 return {'hwnd':int(hwnd or 0),'pid':owner.value,'title':title.value}
def verify_recording_geometry(panel,selection):
 hwnd=panel.handle;panel_rect=window_rect(hwnd);visible=native_windows()
 matches=[w for w in visible if w['hwnd']!=hwnd and all(abs(a-b)<=2 for a,b in zip(w['rect'],selection))]
 report['recording_geometry']={'selected_physical_rect':list(selection),'visible_windows':visible,
     'controls':{'hwnd':int(hwnd),'rect':panel_rect}}
 if len(matches)!=1:raise RuntimeError('Recording region window does not uniquely match the selected physical rectangle')
 region=matches[0];region_hwnd=region['hwnd']
 if not region['extended_style']&0x20:raise RuntimeError('Recording region lost WS_EX_TRANSPARENT click-through')
 for target in [hwnd,region_hwnd]:
  if capture_affinity(target)!=0x11:raise RuntimeError('Recording region or controls lost capture exclusion')
 # Hit the painted border, not its transparent interior, while the safe sample
 # fills the desktop. Input must reach the underlying source application.
 x=round((selection[0]+selection[2])/2);y=selection[1]+1
 hit=user32.WindowFromPoint(wintypes.POINT(x,y));hit_root=user32.GetAncestor(hit,2)
 geometry=report['recording_geometry']
 geometry['edge_hit_before_fixture_activation']=hit_evidence(hit_root)
 geometry['expected_source']=hit_evidence(source_window.handle)
 geometry['source_rect']=window_rect(source_window.handle)
 geometry['source_maximized']=bool(user32.IsZoomed(source_window.handle))
 if not geometry['source_maximized']:raise RuntimeError('Starting recording changed the source maximized state')
 # The assertion concerns border input routing, so make its underlying test
 # fixture the foreground target rather than assuming no other CI window rose.
 focus_source_fixture('Recording input fixture')
 hit=user32.WindowFromPoint(wintypes.POINT(x,y));hit_root=user32.GetAncestor(hit,2)
 geometry['edge_hit_after_fixture_activation']=hit_evidence(hit_root)
 if not user32.IsWindowVisible(region_hwnd):raise RuntimeError('Recording region disappeared when its source was focused')
 if hit_root!=source_window.handle:raise RuntimeError('Recording border input did not reach the focused source: '+json.dumps(geometry['edge_hit_after_fixture_activation']))
 monitor=MonitorInfo();monitor.size=ctypes.sizeof(MonitorInfo)
 if not user32.GetMonitorInfoW(user32.MonitorFromWindow(hwnd,2),ctypes.byref(monitor)):
  raise RuntimeError('Could not read controls monitor work area')
 work=rectangle(monitor.work);left,top,right,bottom=panel_rect
 if left<work[0]-2 or top<work[1]-2 or right>work[2]+2 or bottom>work[3]+2:
  raise RuntimeError('Recording controls extend outside their monitor work area')
 dx=max(selection[0]-right,left-selection[2],0);dy=max(selection[1]-bottom,top-selection[3],0)
 scale=(user32.GetDpiForWindow(hwnd) or 96)/96
 if max(dx,dy)>16*scale+2:raise RuntimeError('Recording controls are detached from the selected region')
 if min(right,selection[2])-max(left,selection[0])>2 and min(bottom,selection[3])-max(top,selection[1])>2:
  raise RuntimeError('Controls obscure this selection despite ample surrounding desktop space')
 report['recording_geometry'].update({'region':region,'work_area':work,'monitor_scale':scale,
     'edge_hit_target':int(hit_root),'region_affinity':capture_affinity(region_hwnd),
     'controls_affinity':capture_affinity(hwnd),'separation_physical':[dx,dy]})
 report['checks'].append('native region matches selection, passes input through and stays capture-protected; controls stay adjacent and inside work area')
 return [hwnd,region_hwnd]
def save_safe_desktop(name):
 # Only the disposable CI desktop with our maximized generated Notepad sample.
 # Capture protection stays enabled, so protected windows are omitted by Windows.
 ImageGrab.grab(bbox=(0,0,width,height)).save(OUT/name)
 report.setdefault('screenshots',[]).append({'file':name,'capture_protection_enabled':True})
def assert_closed(handles):
 deadline=time.monotonic()+8
 while time.monotonic()<deadline:
  if all(not user32.IsWindow(hwnd) for hwnd in handles):return
  time.sleep(.1)
 raise RuntimeError('Recording region or control window survived stopping')
def windows():return desktop.windows(process=pid,visible_only=True)
def find(name,kind='Button',timeout=15):
 end=time.monotonic()+timeout
 while time.monotonic()<end:
  if proc.poll() is not None:raise RuntimeError('Kiri exited: '+str(proc.returncode))
  for w in windows():
   for c in w.descendants(control_type=kind):
    try:
     if re.fullmatch(name,c.window_text()) and c.is_visible() and c.is_enabled():return c
    except Exception:pass
  time.sleep(.1)
 raise RuntimeError('Visible control not found: '+name)
def exists(name):
 try:find(name,timeout=.5);return True
 except RuntimeError:return False
def begin():
 source_window.set_focus();time.sleep(.3)
 keyboard.send_keys('^+a');find('Record').click_input()
 x1,y1=int(width*.2),int(height*.2);x2,y2=int(width*.8),int(height*.65)
 mouse.press(coords=(x1,y1))
 for step in range(1,21):
  ctypes.windll.user32.SetCursorPos(round(x1+(x2-x1)*step/20),round(y1+(y2-y1)*step/20));time.sleep(.035)
 mouse.release(coords=(x2,y2));find('Start Recording').click_input()
 return find('Cancel Countdown',timeout=12),(x1,y1,x2,y2)
def cancelled():
 time.sleep(3.5)
 if proc.poll() is not None:raise RuntimeError('Cancellation exited the application')
 if exists('Pause Recording') or exists('Cancel Countdown'):raise RuntimeError('Cancelled flow remains active')
 if not user32.IsZoomed(source_window.handle):raise RuntimeError('Cancelling capture changed the source maximized state')
 report.setdefault('source_state_after_cancel',[]).append({'maximized':True,'rect':window_rect(source_window.handle)})
def fail_source_focus(message,foreground):
 evidence={'message':message,'expected':hit_evidence(source_window.handle),
     'actual':hit_evidence(user32.GetAncestor(foreground,2)),'foreground':hit_evidence(foreground)}
 failures=report.setdefault('focus_failures',[]);failures.append(evidence)
 filename=f'focus-failure-{len(failures)}.png'
 try:
  save_safe_desktop(filename);evidence['screenshot']=filename
 except Exception as error:evidence['screenshot_error']=str(error)
 raise RuntimeError(message)
def focus_source_fixture(label):
 # UIA's focus request can return before Win32 foreground activation finishes.
 # Wait only for fixture setup; shortcut result checks below never refocus or retry.
 try:source_window.set_focus()
 except Exception as error:
  fail_source_focus(label+' could not request native focus: '+str(error),user32.GetForegroundWindow())
 deadline=time.monotonic()+2
 while True:
  foreground=user32.GetForegroundWindow()
  if user32.GetAncestor(foreground,2)==source_window.handle:return
  if time.monotonic()>=deadline:fail_source_focus(label+' did not take native focus',foreground)
  time.sleep(.05)
def assert_source_foreground(label):
 foreground=user32.GetForegroundWindow();root=user32.GetAncestor(foreground,2)
 if root!=source_window.handle:fail_source_focus(label+' did not preserve the source foreground window',foreground)
 return int(root)
def recording_shortcut(keys,state,verify_state):
 before=assert_source_foreground('Before '+state)
 requested=time.monotonic();keyboard.send_keys(keys)
 verify_state();confirmed=time.monotonic()
 after=assert_source_foreground('After '+state)
 report.setdefault('active_recording_shortcuts',[]).append({'keys':keys,'state':state,
     'requested':requested,'confirmed':confirmed,'foreground_before':before,'foreground_after':after})
 return requested,confirmed
def exercise_recording_controls(recording_windows):
 # Retain real button pause/resume coverage before testing global dispatch.
 time.sleep(3);pause_requested=time.monotonic();find('Pause Recording').click_input()
 find('Resume Recording');pause_confirmed=time.monotonic();time.sleep(5)
 resume_requested=time.monotonic();find('Resume Recording').click_input()
 find('Pause Recording');resume_confirmed=time.monotonic()
 pauses=[{'pause_requested':pause_requested,'pause_confirmed':pause_confirmed,
          'resume_requested':resume_requested,'resume_confirmed':resume_confirmed,'source':'buttons'}]
 time.sleep(3);focus_source_fixture('Recording shortcut fixture')
 pause_requested,pause_confirmed=recording_shortcut('^%+p','paused',lambda:find('Resume Recording'))
 time.sleep(5)
 resume_requested,resume_confirmed=recording_shortcut('^%+p','recording',lambda:find('Pause Recording'))
 pauses.append({'pause_requested':pause_requested,'pause_confirmed':pause_confirmed,
                'resume_requested':resume_requested,'resume_confirmed':resume_confirmed,'source':'global shortcut'})
 time.sleep(1)
 stop_requested,_=recording_shortcut('^%+s','stopped',lambda:assert_closed(recording_windows))
 return pauses,stop_requested
def active_recording_bounds(duration,observed_start,stop_requested,pauses):
 # State acknowledgements bracket each transition. The minimum/maximum pause
 # intervals retain UIA latency rather than assuming the sleep is the pause.
 if len(pauses)!=2:raise RuntimeError('Expected both button and global-shortcut pause intervals')
 minimum_pause=maximum_pause=0;minimum_intervals=[];previous_end=observed_start
 for pause in pauses:
  a,b,c,d=[pause[key] for key in ['pause_requested','pause_confirmed','resume_requested','resume_confirmed']]
  if not previous_end<=a<=b<=c<=d<=stop_requested:raise RuntimeError('Recording transition timestamps are out of order')
  minimum_pause+=c-b;maximum_pause+=d-a;minimum_intervals.append(c-b);previous_end=d
 elapsed=stop_requested-observed_start
 lower=max(0,elapsed-maximum_pause-.1)
 # Preserve the former 2.5-second allowance for the post-countdown observation
 # delay and native stop finalization; never let it absorb the deliberate pauses.
 upper=elapsed-minimum_pause+2.5
 if upper-lower>=min(minimum_intervals):
  raise RuntimeError('Pause observation is too short to prove each pause is excluded from saved media')
 if not lower<=duration<=upper:raise RuntimeError(f'Static recording duration {duration} is outside active elapsed bounds [{lower}, {upper}]')
 return {'measured_wall_seconds':elapsed,'minimum_paused_seconds':minimum_pause,
         'maximum_paused_seconds':maximum_pause,'media_duration_bounds':[lower,upper],'pause_intervals':pauses}
def saved_video(library,before_ids):
 items=json.loads((library/'library.json').read_text(encoding='utf-8'))
 created=[a for a in items if a['id'] not in before_ids and a['kind']=='video']
 if len(created)!=1:raise RuntimeError('Recording did not save exactly one new video')
 asset=created[0];path=library/'Assets'/asset['filename']
 shell=win32com.client.Dispatch('Shell.Application')
 item=shell.NameSpace(str(path.parent)).ParseName(path.name)
 duration=float(item.ExtendedProperty('System.Media.Duration'))/10_000_000
 if duration<=0 or path.stat().st_size<=0:raise RuntimeError('Saved recording has no valid duration or bytes')
 return asset,path,duration,items
try:
 find('Settings',timeout=35)
 sample=Path(os.environ['RUNNER_TEMP'])/'kiri-countdown-check.txt'
 sample.write_text('An original local recording sample.\nCancel, then start a new recording.\n',encoding='utf-8')
 subprocess.Popen(['notepad.exe',str(sample)])
 source_window=desktop.window(title_re='.*kiri-countdown-check.*')
 source_window.wait('visible',timeout=20);source_window.maximize();source_window.set_focus();time.sleep(.5)
 maximized_deadline=time.monotonic()+3
 while not user32.IsZoomed(source_window.handle):
  if time.monotonic()>=maximized_deadline:raise RuntimeError('Source fixture did not maximize before capture')
  time.sleep(.05)
 for mode in ['click','Escape']*3:
  cancel,_=begin();parent=cancel.top_level_parent();h=parent.handle
  if not parent.is_visible():raise RuntimeError('Countdown is not visible')
  if ctypes.windll.user32.GetForegroundWindow()!=h:raise RuntimeError('Countdown lacks native focus')
  affinity=wintypes.DWORD()
  ok=ctypes.windll.user32.GetWindowDisplayAffinity(h,ctypes.byref(affinity))
  if not ok or affinity.value!=0x11:raise RuntimeError('Countdown capture exclusion lost')
  if mode=='click':cancel.click_input()
  else:keyboard.send_keys('{ESC}')
  cancelled();report['checks'].append(mode+' cancellation; visible, focused and capture-protected')
 library=Path(os.environ['APPDATA'])/'kiri'
 before_ids={a['id'] for a in json.loads((library/'library.json').read_text(encoding='utf-8'))} if (library/'library.json').exists() else set()
 cancel,selection=begin();seen=set();deadline=time.monotonic()+4
 while time.monotonic()<deadline:
  try:
   for t in cancel.top_level_parent().descendants(control_type='Text'):
    match=re.fullmatch(r'(?:Recording starts in )?([123])',t.window_text())
    if match:seen.add(match.group(1))
  except Exception:pass
  time.sleep(.12)
 report['observed_digits']=sorted(seen)
 if not {'1','2'}.issubset(seen):raise RuntimeError('Countdown digits did not advance visibly')
 pause=find('Pause Recording',timeout=35);stop=find('Stop and Save Recording');panel=stop.top_level_parent()
 affinity=wintypes.DWORD();ctypes.windll.user32.GetWindowDisplayAffinity(panel.handle,ctypes.byref(affinity))
 if affinity.value!=0x11:raise RuntimeError('Recording controls lost capture exclusion')
 qa_started=time.monotonic()
 recording_windows=verify_recording_geometry(panel,selection)
 save_safe_desktop('recording-active-desktop.png')
 qa_active_seconds=time.monotonic()-qa_started
 # Static source: WGC callbacks need not arrive at the configured frame rate.
 pauses,stop_requested=exercise_recording_controls(recording_windows);time.sleep(5)
 assert_closed(recording_windows)
 report['checks'].append('recording region and control HWNDs both close after global stop')
 save_safe_desktop('recording-stopped-desktop.png')
 asset,path,duration,items=saved_video(library,before_ids)
 report['static_recording']={'asset_id':asset['id'],'media_duration':duration,
     'native_geometry_qa_seconds':qa_active_seconds,'file_size':path.stat().st_size,
     'observed_start':qa_started,'stop_requested':stop_requested,'pause_intervals':pauses}
 report['static_recording'].update(active_recording_bounds(duration,qa_started,stop_requested,pauses))
 report['checks'].append('global Ctrl+Alt+Shift+P pauses and resumes from the source foreground; Ctrl+Alt+Shift+S stops and saves without stealing focus')
 report['checks'].append('static desktop MP4 preserves measured active time and excludes both button and global-shortcut pauses')
 # Keep Stop and Save Recording button acceptance in a second short capture,
 # without repeating countdown cancellation or the geometry matrix.
 second_before={a['id'] for a in items}
 _,second_selection=begin();find('Pause Recording',timeout=35)
 second_stop=find('Stop and Save Recording');second_panel=second_stop.top_level_parent()
 second_windows=[w['hwnd'] for w in native_windows() if w['hwnd']==second_panel.handle
                 or all(abs(a-b)<=2 for a,b in zip(w['rect'],second_selection))]
 if len(second_windows)!=2:raise RuntimeError('Second recording has no unique region and controls')
 second_started=time.monotonic();time.sleep(2)
 second_stop_requested=time.monotonic();second_stop.click_input();assert_closed(second_windows);time.sleep(5)
 second_asset,second_path,second_duration,final_items=saved_video(library,second_before)
 if not 2<=second_duration<=second_stop_requested-second_started+2.5:
  raise RuntimeError('Button-stopped recording duration is outside its short active interval')
 if len([a for a in final_items if a['id'] not in before_ids and a['kind']=='video'])!=2:
  raise RuntimeError('Two recording completions did not save exactly two videos')
 report['button_stop_recording']={'asset_id':second_asset['id'],'media_duration':second_duration,
     'measured_active_seconds':second_stop_requested-second_started,'file_size':second_path.stat().st_size}
 report['checks'].append('Stop and Save Recording button closes both native windows and saves exactly one separate short MP4')
 report['checks'].append('countdown completed; button and active global shortcut pause/resume/stop paths are independently exercised')
 report['success']=True
except Exception as error:
 report['error']=str(error)[:1500];report.update(collect_crash_details(OUT,proc));report['windows']=[]
 for w in windows():
  try:report['windows'].append({'title':w.window_text(),'controls':[{'type':c.element_info.control_type,'text':c.window_text()} for c in w.descendants()]})
  except Exception:pass
finally:
 log=Path(os.environ['LOCALAPPDATA'])/'io.yuxino.kiri/logs/kiri.log'
 if log.exists():(OUT/'application.log').write_text('\n'.join(log.read_text(encoding='utf-8',errors='replace').splitlines()[-350:])+'\n',encoding='utf-8')
 (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
 subprocess.run(['taskkill','/PID',str(pid),'/T','/F'],capture_output=True)
 if source_window:
  try:source_window.close()
  except Exception:pass
if not report['success']:raise SystemExit(report['error'])
