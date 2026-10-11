// Clear to Air - desktop launcher.
//
// A small tray application that owns the agent process. It exists so that the
// product is a folder you unzip and an .exe you double-click, not a Node
// toolchain and a batch file:
//
//   Clear to Air.exe        this launcher (tray icon = the lamp)
//   runtime\node.exe        the Node runtime the agent runs on
//   app\                    package.json, agent\, packs\, overlays\, web\dist\
//   app\agent\data\         state.json, adapters.json, captures\ - survives updates
//   launcher.log            this launcher's lines AND the agent's console output, local
//                           time; rolls at 2 MB to launcher.log.old. Tray > Open log.
//
// What it does:
//   * starts runtime\node.exe app\agent\src\index.js hidden, restarts it if it dies
//   * waits for http://127.0.0.1:7700/healthz, then opens the control room
//   * tray icon: green = CLEAR TO AIR, amber = agent up with preflight faults,
//     red = agent down; menu: open, restart, check for updates, open folder, quit
//   * updates: asks the agent (/api/update) which reads the release manifest;
//     verifies the manifest's signature itself against the public key compiled in
//     (ReleaseKey.cs, see ManifestCheck below) BEFORE downloading anything, so a
//     compromised GitHub repo or release cannot ship code; refuses a version that is
//     not newer than this install; downloads the zip over https only, refuses a
//     manifest without a sha256 and verifies it before anything is extracted,
//     refuses any zip entry that would land outside app.next, then swaps on restart keeping agent\data and cached
//     team logos. The launcher itself is replaced on the next start via
//     "Clear to Air.exe.new".
//   * stops the agent with POST /api/shutdown (it saves pending state), and only
//     kills it if it has not exited ~3 s later.
//
// Built with the csc.exe that ships with Windows (.NET Framework 4.x) - see
// build.cmd. No NuGet, no SDK, no installer.
//
// Hidden test switch: "Clear to Air.exe" --verify-manifest <latest.json> only checks
// that file's signature, prints OK or FAIL <why> and exits 0 / 1. It starts nothing.
// --pubkey-x <hex> --pubkey-y <hex> (honoured only with --verify-manifest) swap the
// built-in key for a test key; agent/src/_selftest.js uses it for the cross-language check.

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace ClearToAir
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            int vi = Array.IndexOf(args, "--verify-manifest");
            if (vi >= 0) return ManifestCheck.Cli(args, vi);
            bool created;
            using (var mutex = new Mutex(true, "ClearToAir.Launcher.SingleInstance", out created))
            {
                if (!created)
                {
                    // Already running: just open the control room again.
                    try { Process.Start("http://127.0.0.1:" + Launcher.Port + "/"); } catch { }
                    return 0;
                }
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new Launcher());
            }
            return 0;
        }
    }

    class Launcher : ApplicationContext
    {
        public const int Port = 7700;
        static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        static readonly string AppDir = Path.Combine(Root, "app");
        static readonly string NextDir = Path.Combine(Root, "app.next");
        static readonly string NodeExe = Path.Combine(Root, "runtime", "node.exe");
        static readonly string LogFile = Path.Combine(Root, "launcher.log");
        const long LogMaxBytes = 2 * 1024 * 1024;   // agent stdout is mirrored here; a week-long run grew without bound
        static readonly string ExePath = Path.Combine(Root, "Clear to Air.exe");

        readonly NotifyIcon tray;
        readonly System.Windows.Forms.Timer poll;
        Process node;
        string lastState = "";
        bool quitting;
        bool updating;
        string version = "?";

        public Launcher()
        {
            Log("launcher start, root=" + Root);
            SwapPendingLauncher();
            SwapPendingApp();
            version = ReadVersion();

            tray = new NotifyIcon();
            tray.Text = "Clear to Air";
            tray.Icon = LampIcon("idle");
            lastState = "idle";
            tray.Visible = true;
            tray.DoubleClick += (s, e) => OpenControlRoom();

            var menu = new ContextMenuStrip();
            menu.Items.Add("Open control room", null, (s, e) => OpenControlRoom());
            menu.Items.Add("Restart agent", null, (s, e) => RestartAgent());
            menu.Items.Add("Check for updates...", null, (s, e) => CheckForUpdates(true));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Open app folder", null, (s, e) => Process.Start("explorer.exe", Root));
            // launcher.log is the one log there is: the agent writes only to its console,
            // which StartAgent mirrors in here. (It used to open app\agent\data\agent.log,
            // which nothing writes.) Notepad, not the .log association, which may be unset.
            menu.Items.Add("Open log", null, (s, e) => OpenLog());
            menu.Items.Add(new ToolStripSeparator());
            var v = new ToolStripMenuItem("Clear to Air " + version); v.Enabled = false; menu.Items.Add(v);
            menu.Items.Add("Quit", null, (s, e) => Quit());
            tray.ContextMenuStrip = menu;

            if (!File.Exists(NodeExe))
            {
                MessageBox.Show("runtime\\node.exe is missing next to Clear to Air.exe.\nRe-extract the download.", "Clear to Air", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Quit(); return;
            }

            StartAgent();
            poll = new System.Windows.Forms.Timer { Interval = 4000 };
            poll.Tick += (s, e) => Poll();
            poll.Start();

            var opener = new System.Windows.Forms.Timer { Interval = 800 };
            int tries = 0;
            opener.Tick += (s, e) =>
            {
                tries++;
                if (Healthy() != null) { opener.Stop(); OpenControlRoom(); Poll(); CheckForUpdates(false); }
                else if (tries > 40) { opener.Stop(); tray.ShowBalloonTip(4000, "Clear to Air", "The agent did not answer in 30 s. See launcher.log.", ToolTipIcon.Warning); }
            };
            opener.Start();
        }

        // ---- agent process -------------------------------------------------------
        void StartAgent()
        {
            try
            {
                var psi = new ProcessStartInfo(NodeExe, "\"" + Path.Combine(AppDir, "agent", "src", "index.js") + "\"")
                {
                    WorkingDirectory = AppDir, UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                };
                psi.EnvironmentVariables["CTA_PORT"] = Port.ToString();
                psi.EnvironmentVariables["CTA_LAUNCHER"] = version;
                var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
                node = proc;
                proc.OutputDataReceived += (s, e) => { if (e.Data != null) Log("agent " + e.Data); };
                proc.ErrorDataReceived += (s, e) => { if (e.Data != null) Log("agent! " + e.Data); };
                proc.Exited += (s, e) =>
                {
                    Log("agent exited code " + SafeExitCode(proc));
                    // Exited is raised on the thread pool and can land after StopAgent has
                    // returned; only the current process may trigger an auto-restart.
                    if (!quitting && !updating && proc == node)
                    {
                        Paint("down");
                        var t = new System.Threading.Timer(_ => { try { StartAgent(); } catch (Exception ex) { Log("restart failed: " + ex.Message); } }, null, 2500, Timeout.Infinite);
                    }
                };
                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                Log("agent started pid " + proc.Id);
            }
            catch (Exception ex)
            {
                Log("could not start the agent: " + ex.Message);
                MessageBox.Show("Could not start the agent:\n" + ex.Message, "Clear to Air", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        static int SafeExitCode(Process p) { try { return p.ExitCode; } catch { return -1; } }

        /// POST /api/shutdown. The agent's request guard wants a loopback Host (this
        /// request sends 127.0.0.1:<port>) and a JSON content type.
        static bool RequestShutdown()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port + "/api/shutdown");
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Timeout = 1500;
                var body = Encoding.UTF8.GetBytes("{}");
                req.ContentLength = body.Length;
                using (var s = req.GetRequestStream()) s.Write(body, 0, body.Length);
                using (var res = (HttpWebResponse)req.GetResponse()) return (int)res.StatusCode < 300;
            }
            catch (Exception ex) { Log("shutdown request: " + ex.Message); return false; }
        }

        void StopAgent()
        {
            try
            {
                if (node != null && !node.HasExited)
                {
                    // There is no SIGINT for a windowless child on Windows, and a kill
                    // skips the agent's debounced save - an edit made in the last
                    // 300 ms was lost. Ask first; kill only if it does not finish.
                    bool asked = RequestShutdown();
                    if (!asked || !node.WaitForExit(3000))
                    {
                        Log(asked ? "agent did not exit in 3 s - killing" : "shutdown request failed - killing");
                        node.Kill();
                        node.WaitForExit(3000);
                    }
                    else Log("agent stopped cleanly");
                }
            }
            catch { }
            node = null;
        }

        void RestartAgent()
        {
            Log("restart requested");
            updating = true;    // suppress the auto-restart in Exited
            StopAgent();
            updating = false;
            StartAgent();
        }

        void Quit()
        {
            quitting = true;
            if (poll != null) poll.Stop();
            StopAgent();
            tray.Visible = false;
            Application.Exit();
        }

        // ---- health + tray lamp ------------------------------------------------------
        string Healthy()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port + "/healthz");
                req.Timeout = 1500;
                using (var res = (HttpWebResponse)req.GetResponse())
                using (var rd = new StreamReader(res.GetResponseStream()))
                    return rd.ReadToEnd();
            }
            catch { return null; }
        }

        void Poll()
        {
            var body = Healthy();
            if (body == null) { Paint("down"); return; }
            bool clear = Regex.IsMatch(body, "\"clear\"\\s*:\\s*true");
            bool obs = Regex.IsMatch(body, "\"connected\"\\s*:\\s*true");
            var wm = Regex.Match(body, "\"warns\"\\s*:\\s*(\\d+)");
            int warns = wm.Success ? int.Parse(wm.Groups[1].Value) : 0;
            // The designers' four lamp states: Clear, Warnings, Faults, Idle.
            Paint(!clear ? "fail" : warns > 0 ? "warn" : "ok");
            tray.Text = Clip("Clear to Air " + version + (!clear ? " - preflight faults" : warns > 0 ? " - clear, " + warns + " warning" + (warns == 1 ? "" : "s") : " - CLEAR TO AIR") + (obs ? "" : " - OBS offline"));
        }

        // NotifyIcon.Text throws past 63 characters.
        static string Clip(string s) { return s.Length > 63 ? s.Substring(0, 63) : s; }

        void Paint(string state)
        {
            if (state == "down") { state = "fail"; tray.Text = Clip("Clear to Air " + version + " - agent not responding"); }
            if (state == lastState) return;
            lastState = state;
            var old = tray.Icon;
            var oldHandle = lampHandle;
            tray.Icon = LampIcon(state);
            if (old != null) try { old.Dispose(); } catch { }
            if (oldHandle != IntPtr.Zero) DestroyIcon(oldHandle);
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        static extern bool DestroyIcon(IntPtr handle);
        static IntPtr lampHandle = IntPtr.Zero;

        /// The tray lamp is the logo's mark, one PNG per state embedded by build.cmd
        /// (tools/launcher/brand/tray-<state>-<px>.png, drawn from brand/mark.svg).
        static Icon LampIcon(string state)
        {
            int want = SystemInformation.SmallIconSize.Width;   // 16 at 100 %, 20/24/32 at higher DPI
            int[] sizes = { 16, 20, 24, 32, 48 };
            int px = sizes[sizes.Length - 1];
            foreach (var s in sizes) if (s >= want) { px = s; break; }
            var asm = System.Reflection.Assembly.GetExecutingAssembly();
            using (var stream = asm.GetManifestResourceStream("tray-" + state + "-" + px + ".png"))
            {
                if (stream == null) { Log("tray icon tray-" + state + "-" + px + ".png not embedded - rebuild with tools\\launcher\\build.cmd"); return SystemIcons.Application; }
                using (var bmp = new Bitmap(stream))
                {
                    lampHandle = bmp.GetHicon();
                    return Icon.FromHandle(lampHandle);
                }
            }
        }


        void OpenControlRoom()
        {
            try { Process.Start("http://127.0.0.1:" + Port + "/"); } catch (Exception ex) { Log("open failed: " + ex.Message); }
        }

        /// Tray > Open log: launcher.log in Notepad. Times in it are this PC's local time.
        static void OpenLog()
        {
            Log("log opened from the tray");   // also makes sure the file exists
            try { Process.Start("notepad.exe", "\"" + LogFile + "\""); }
            catch (Exception ex)
            {
                try { Process.Start("explorer.exe", "/select,\"" + LogFile + "\""); }
                catch { Say("Could not open the log: " + ex.Message + "\n\nIt is " + LogFile); }
            }
        }

        // ---- updates -----------------------------------------------------------------
        void CheckForUpdates(bool interactive)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    var json = Get("http://127.0.0.1:" + Port + "/api/update" + (interactive ? "?force=1" : ""), 15000);
                    if (json == null) { if (interactive) Say("The agent is not answering, so the update check could not run."); return; }
                    bool available = Regex.IsMatch(json, "\"available\"\\s*:\\s*true");
                    string latest = Field(json, "latest"), url = Field(json, "url"), sha = Field(json, "sha256"), notes = Field(json, "notes"), err = Field(json, "error");
                    if (!available)
                    {
                        if (interactive) Say(err != null ? "Update check failed: " + err : "You are on the latest version (" + version + ").");
                        return;
                    }
                    if (url == null) { if (interactive) Say("Version " + latest + " is out, but the manifest carries no download URL."); return; }
                    // The agent checked the signature too, but the launcher is what installs:
                    // it trusts only its own check, and only the fields it checked.
                    var signed = SignedFields(json);
                    string bad = ManifestCheck.Verify(signed, ReleaseKey.Keys);
                    if (bad == null && ManifestCheck.CompareVersions(latest, version) <= 0) bad = "version " + latest + " is not newer than this install (" + version + ")";
                    if (bad != null)
                    {
                        Log("refused update manifest: " + bad);
                        if (interactive) Say("An update was offered but refused: " + bad + ".\nNothing was downloaded.");
                        return;
                    }
                    var ask = MessageBox.Show("Clear to Air " + latest + " is available.\n" + (notes ?? "") + "\n\nDownload and install now? The agent restarts for a few seconds; OBS keeps running.",
                        "Clear to Air update", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                    if (ask != DialogResult.Yes) return;
                    ApplyUpdate(signed);
                }
                catch (Exception ex) { Log("update check: " + ex.Message); if (interactive) Say("Update check failed: " + ex.Message); }
            });
        }

        /// The signed fields of the agent's /api/update answer ("latest" is the manifest's version).
        static string[] SignedFields(string json)
        {
            return new string[] { Field(json, "latest"), Field(json, "url"), Field(json, "sha256"), ManifestCheck.NumField(json, "size"), Field(json, "file"), Field(json, "sig"), Field(json, "keyId") };
        }

        void ApplyUpdate(string[] signed)
        {
            // Nothing is downloaded unless the release key signed exactly these fields.
            // Whoever controls the URL controls what runs next, so the signature covers
            // the URL and the checksum, and both are required.
            string bad = ManifestCheck.Verify(signed, ReleaseKey.Keys);
            if (bad != null) { Say("The update was refused: " + bad + ". Nothing was changed."); Log("refused update manifest: " + bad); return; }
            string latest = signed[0], url = signed[1], sha = signed[2];
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || uri.Scheme != Uri.UriSchemeHttps)
            { Say("The update was refused: its download link is not https. Nothing was changed."); Log("refused non-https update url " + url); return; }
            if (sha == null || !Regex.IsMatch(sha, "^[0-9a-fA-F]{64}$"))
            { Say("The update was refused: the release manifest carries no sha256 checksum. Nothing was changed."); Log("refused update without sha256"); return; }
            if (latest == null || !Regex.IsMatch(latest, "^[0-9A-Za-z.+-]{1,40}$")) latest = "update";   // it names a temp file

            var tmp = Path.Combine(Path.GetTempPath(), "ClearToAir-" + latest + ".zip");
            Log("downloading " + url);
            using (var wc = new WebClient()) { wc.Headers["User-Agent"] = "ClearToAir-launcher/" + version; wc.DownloadFile(uri, tmp); }
            var got = Sha256(tmp);
            if (!string.Equals(got, sha, StringComparison.OrdinalIgnoreCase))
            {
                try { File.Delete(tmp); } catch { }
                Say("The download did not match its checksum. Nothing was changed."); Log("sha mismatch " + got + " != " + sha); return;
            }
            // Extract the zip's app\ into app.next, and the launcher into .exe.new.
            if (Directory.Exists(NextDir)) Directory.Delete(NextDir, true);
            Directory.CreateDirectory(NextDir);
            var nextRoot = Path.GetFullPath(NextDir).TrimEnd('\\') + "\\";
            string newExe = null;
            try
            {
                using (var zip = ZipFile.OpenRead(tmp))
                {
                    foreach (var entry in zip.Entries)
                    {
                        var rel = entry.FullName.Replace('\\', '/');
                        // tolerate one top-level folder in the zip: "app/..." or "<folder>/app/..."
                        int i = rel.IndexOf("app/", StringComparison.Ordinal);
                        if (i > 0 && (rel[i - 1] != '/' || rel.IndexOf('/') != i - 1)) i = -1;
                        if (i >= 0)
                        {
                            var sub = rel.Substring(i + 4);
                            if (sub.Length == 0 || rel.EndsWith("/")) continue;
                            // zip-slip: "app/../../x" or an absolute/drive path must not escape app.next
                            string dest;
                            try { dest = Path.GetFullPath(Path.Combine(NextDir, sub.Replace('/', '\\'))); }
                            catch (Exception ex) { throw new InvalidDataException("bad entry name " + entry.FullName + ": " + ex.Message); }
                            if (!dest.StartsWith(nextRoot, StringComparison.OrdinalIgnoreCase))
                                throw new InvalidDataException("entry escapes the app folder: " + entry.FullName);
                            Directory.CreateDirectory(Path.GetDirectoryName(dest));
                            entry.ExtractToFile(dest, true);
                        }
                        else if (rel.EndsWith("/Clear to Air.exe", StringComparison.OrdinalIgnoreCase) || rel.Equals("Clear to Air.exe", StringComparison.OrdinalIgnoreCase))
                        {
                            newExe = ExePath + ".new";
                            entry.ExtractToFile(newExe, true);
                        }
                        // runtime\node.exe is not replaced by an app update.
                    }
                }
            }
            catch (Exception ex)
            {
                // A half-extracted app.next would be swapped in on the next start: remove it.
                Log("update refused: " + ex.Message);
                try { Directory.Delete(NextDir, true); } catch { }
                if (newExe != null) try { File.Delete(newExe); } catch { }
                try { File.Delete(tmp); } catch { }
                Say("The update was refused: " + ex.Message + "\nNothing was changed.");
                return;
            }
            try { File.Delete(tmp); } catch { }
            Log("update staged in app.next" + (newExe != null ? " + launcher" : ""));
            updating = true;
            StopAgent();
            SwapPendingApp();
            version = ReadVersion();
            updating = false;
            StartAgent();
            Say("Updated to " + version + ". The agent is restarting." + (newExe != null ? "\nThe launcher itself updates the next time you start Clear to Air." : ""));
        }

        /// app.next -> app, keeping agent\data and cached team logos from the old app.
        static void SwapPendingApp()
        {
            if (!Directory.Exists(NextDir)) return;
            try
            {
                var oldData = Path.Combine(AppDir, "agent", "data");
                var newData = Path.Combine(NextDir, "agent", "data");
                if (Directory.Exists(oldData)) { if (Directory.Exists(newData)) Directory.Delete(newData, true); Directory.CreateDirectory(Path.GetDirectoryName(newData)); Directory.Move(oldData, newData); }
                var oldPacks = Path.Combine(AppDir, "packs");
                if (Directory.Exists(oldPacks))
                    foreach (var pack in Directory.GetDirectories(oldPacks))
                    {
                        var teams = Path.Combine(pack, "assets", "teams");
                        if (!Directory.Exists(teams)) continue;
                        var dest = Path.Combine(NextDir, "packs", Path.GetFileName(pack), "assets", "teams");
                        Directory.CreateDirectory(dest);
                        foreach (var f in Directory.GetFiles(teams)) File.Copy(f, Path.Combine(dest, Path.GetFileName(f)), true);
                    }
                var prev = Path.Combine(Root, "app.prev");
                if (Directory.Exists(prev)) Directory.Delete(prev, true);
                if (Directory.Exists(AppDir)) Directory.Move(AppDir, prev);
                Directory.Move(NextDir, AppDir);
                try { Directory.Delete(prev, true); } catch { }
                Log("app swapped");
            }
            catch (Exception ex) { Log("swap failed: " + ex.Message); }
        }

        /// A staged launcher replaces this exe through a detached cmd, then relaunches.
        static void SwapPendingLauncher()
        {
            var staged = ExePath + ".new";
            if (!File.Exists(staged)) return;
            try
            {
                var cmd = "/c timeout /t 2 /nobreak >nul & move /y \"" + staged + "\" \"" + ExePath + "\" & start \"\" \"" + ExePath + "\"";
                Process.Start(new ProcessStartInfo("cmd.exe", cmd) { CreateNoWindow = true, UseShellExecute = false });
                Environment.Exit(0);
            }
            catch (Exception ex) { Log("launcher swap failed: " + ex.Message); }
        }

        static string ReadVersion()
        {
            try
            {
                var pj = File.ReadAllText(Path.Combine(AppDir, "package.json"));
                var m = Regex.Match(pj, "\"version\"\\s*:\\s*\"([^\"]+)\"");
                return m.Success ? m.Groups[1].Value : "?";
            }
            catch { return "?"; }
        }

        static string Get(string url, int timeout)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = timeout;
                using (var res = (HttpWebResponse)req.GetResponse())
                using (var rd = new StreamReader(res.GetResponseStream()))
                    return rd.ReadToEnd();
            }
            catch { return null; }
        }

        internal static string Field(string json, string key)
        {
            var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            return m.Success ? Regex.Unescape(m.Groups[1].Value) : null;
        }

        static string Sha256(string file)
        {
            using (var sha = SHA256.Create())
            using (var fs = File.OpenRead(file))
            {
                var sb = new StringBuilder();
                foreach (var b in sha.ComputeHash(fs)) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        static void Say(string text) { MessageBox.Show(text, "Clear to Air", MessageBoxButtons.OK, MessageBoxIcon.Information); }

        static readonly object logLock = new object();
        static void Log(string line)
        {
            try
            {
                lock (logLock)
                {
                    // Rotate at ~2 MB, keeping one launcher.log.old.
                    var fi = new FileInfo(LogFile);
                    if (fi.Exists && fi.Length > LogMaxBytes)
                    {
                        var old = LogFile + ".old";
                        if (File.Exists(old)) File.Delete(old);
                        File.Move(LogFile, old);
                    }
                    File.AppendAllText(LogFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line + Environment.NewLine);
                }
            }
            catch { }
        }
    }

    /// Release-manifest signatures. ECDSA P-256 / SHA-256, signature as IEEE P1363
    /// (r||s, 64 bytes, base64) over a fixed byte string - the same one
    /// agent/src/update.js manifestPayload() builds:
    ///   "cleartoair-manifest-v1\n" + version + "\n" + url + "\n" + sha256 (lowercase) + "\n" + size + "\n" + file + "\n"
    /// Every field is validated first (printable ASCII, no spaces or newlines), so no
    /// two different manifests share a payload. notes and date are not signed.
    static class ManifestCheck
    {
        // SubjectPublicKeyInfo DER for a P-256 key, up to the uncompressed point (04 || X || Y).
        // keyId = first 16 hex of sha256(this prefix + 04 + X + Y), as in Node's keyIdOf().
        const string SpkiPrefix = "3059301306072a8648ce3d020106082a8648ce3d030107034200";
        // \z, not $: in .NET "$" also matches before a final newline.
        const string Printable = "^[\\x21-\\x7E]+\\z";

        /// f = version, url, sha256, size, file, sig, keyId. null = good; otherwise why not.
        public static string Verify(string[] f, string[][] keys)
        {
            if (f == null || f.Length != 7) return "the manifest is malformed";
            string version = f[0], url = f[1], sha = f[2], size = f[3], file = f[4], sig = f[5], keyId = f[6];
            if (sig == null || keyId == null) return "the release manifest is not signed";
            if (!Regex.IsMatch(sig, "^[A-Za-z0-9+/]{86}==\\z")) return "the signature is not 64 bytes of base64";
            if (version == null || !Regex.IsMatch(version, "^[0-9A-Za-z.+-]{1,40}\\z")) return "the manifest version is malformed";
            if (url == null || !url.StartsWith("https://", StringComparison.Ordinal) || url.Length > 2000 || !Regex.IsMatch(url, Printable)) return "the download link is not a plain https URL";
            if (sha == null || !Regex.IsMatch(sha, "^[0-9a-fA-F]{64}\\z")) return "the manifest carries no sha256 checksum";
            if (size == null || !Regex.IsMatch(size, "^[0-9]{1,15}\\z")) return "the manifest size is malformed";
            if (file == null || file.Length > 200 || !Regex.IsMatch(file, Printable)) return "the manifest file name is malformed";
            var payload = Encoding.UTF8.GetBytes("cleartoair-manifest-v1\n" + version + "\n" + url + "\n" + sha.ToLowerInvariant() + "\n" + size + "\n" + file + "\n");
            var sigBytes = Convert.FromBase64String(sig);
            if (keys != null)
                foreach (var k in keys)
                {
                    if (k == null || k.Length < 2) continue;
                    byte[] x = Hex(k[0]), y = Hex(k[1]);
                    if (x == null || y == null || x.Length != 32 || y.Length != 32) continue;
                    if (!string.Equals(KeyId(x, y), keyId, StringComparison.OrdinalIgnoreCase)) continue;
                    // BCRYPT_ECCKEY_BLOB: magic "ECS1" (ECDSA P-256 public), cbKey = 32, then X, then Y.
                    var blob = new byte[8 + 64];
                    BitConverter.GetBytes(0x31534345).CopyTo(blob, 0);
                    BitConverter.GetBytes(32).CopyTo(blob, 4);
                    Buffer.BlockCopy(x, 0, blob, 8, 32);
                    Buffer.BlockCopy(y, 0, blob, 40, 32);
                    using (var key = CngKey.Import(blob, CngKeyBlobFormat.EccPublicBlob))
                    using (var ec = new ECDsaCng(key))
                    {
                        ec.HashAlgorithm = CngAlgorithm.Sha256;
                        return ec.VerifyData(payload, sigBytes) ? null : "the signature does not match the release key";
                    }
                }
            return "it is signed by an unknown key (" + keyId + ")";
        }

        static string KeyId(byte[] x, byte[] y)
        {
            var prefix = Hex(SpkiPrefix);
            var der = new byte[prefix.Length + 65];
            Buffer.BlockCopy(prefix, 0, der, 0, prefix.Length);
            der[prefix.Length] = 0x04;
            Buffer.BlockCopy(x, 0, der, prefix.Length + 1, 32);
            Buffer.BlockCopy(y, 0, der, prefix.Length + 33, 32);
            using (var sha = SHA256.Create())
            {
                var sb = new StringBuilder();
                foreach (var b in sha.ComputeHash(der)) sb.Append(b.ToString("x2"));
                return sb.ToString().Substring(0, 16);
            }
        }

        static byte[] Hex(string s)
        {
            if (s == null || s.Length % 2 != 0 || !Regex.IsMatch(s, "^[0-9a-fA-F]*\\z")) return null;
            var b = new byte[s.Length / 2];
            for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(s.Substring(i * 2, 2), 16);
            return b;
        }

        /// A bare JSON number field ("size": 123), as digits; null if absent or not a whole number.
        public static string NumField(string json, string key)
        {
            var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*([0-9]+)(?![0-9.eE])");
            return m.Success ? m.Groups[1].Value : null;
        }

        /// semver-ish, pre-release tags ignored - the same rule as agent/src/update.js compareVersions.
        public static int CompareVersions(string a, string b)
        {
            string[] pa = (a ?? "0").Split('-')[0].Split('.'), pb = (b ?? "0").Split('-')[0].Split('.');
            for (int i = 0; i < Math.Max(pa.Length, pb.Length); i++)
            {
                int x = 0, y = 0;
                if (i < pa.Length) int.TryParse(pa[i], out x);
                if (i < pb.Length) int.TryParse(pb[i], out y);
                if (x != y) return x > y ? 1 : -1;
            }
            return 0;
        }

        /// --verify-manifest <file> [--pubkey-x <hex> --pubkey-y <hex>]: prints OK / FAIL, exit 0 / 1.
        public static int Cli(string[] args, int at)
        {
            string result;
            try
            {
                if (at + 1 >= args.Length) throw new ArgumentException("usage: --verify-manifest <latest.json> [--pubkey-x <hex> --pubkey-y <hex>]");
                var keys = ReleaseKey.Keys;
                int xi = Array.IndexOf(args, "--pubkey-x"), yi = Array.IndexOf(args, "--pubkey-y");
                if (xi >= 0 || yi >= 0)
                {
                    if (xi < 0 || yi < 0 || xi + 1 >= args.Length || yi + 1 >= args.Length) throw new ArgumentException("--pubkey-x and --pubkey-y go together");
                    keys = new string[][] { new string[] { args[xi + 1], args[yi + 1] } };
                }
                var json = File.ReadAllText(args[at + 1]);
                var f = new string[] { Launcher.Field(json, "version"), Launcher.Field(json, "url"), Launcher.Field(json, "sha256"), NumField(json, "size"), Launcher.Field(json, "file"), Launcher.Field(json, "sig"), Launcher.Field(json, "keyId") };
                var bad = Verify(f, keys);
                result = bad == null ? "OK" : "FAIL " + bad;
            }
            catch (Exception ex) { result = "FAIL " + ex.Message; }
            Console.Out.WriteLine(result);
            Console.Out.Flush();
            return result == "OK" ? 0 : 1;
        }
    }
}
