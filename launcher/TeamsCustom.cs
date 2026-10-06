using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Program
{
    internal const string MutexName = @"Local\TeamsCustomLauncher";
    internal static readonly int ShowMessage = RegisterWindowMessage("TeamsCustomLauncher.Show");

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int RegisterWindowMessage(string message);
    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam);

    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            string appData = Environment.GetEnvironmentVariable("APPDATA");
            if (args.Length == 0 && String.IsNullOrEmpty(appData))
                throw new ArgumentException("APPDATA is not defined; supply --data-dir PATH.");
            string dataDir = Path.Combine(appData ?? "", "TeamsCustom");
            if (args.Length != 0)
            {
                if (args.Length != 2 || args[0] != "--data-dir" || String.IsNullOrWhiteSpace(args[1]))
                    throw new ArgumentException("Usage: TeamsCustom.exe [--data-dir PATH]");
                dataDir = Path.GetFullPath(args[1]);
            }
            dataDir = Path.GetFullPath(dataDir);
            bool created;
            using (Mutex instance = new Mutex(true, MutexName, out created))
            {
                if (!created)
                {
                    PostMessage(new IntPtr(0xffff), ShowMessage, IntPtr.Zero, IntPtr.Zero);
                    return;
                }
                try { Application.Run(new LauncherForm(dataDir)); }
                finally { instance.ReleaseMutex(); }
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Teams Custom — startup error", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    // Windows CRT quoting: double backslashes before quotes and the closing quote.
    internal static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(character);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }
}

internal sealed class BoundedLog
{
    private const long Limit = 1024 * 1024;
    private readonly object gate = new object();
    internal readonly string DirectoryPath;
    private readonly string file;
    internal string Failure;

    internal BoundedLog(string dataDir)
    {
        DirectoryPath = Path.Combine(dataDir, "logs");
        file = Path.Combine(DirectoryPath, "launcher.log");
    }

    internal void Prepare()
    {
        string root = Path.GetDirectoryName(DirectoryPath);
        Directory.CreateDirectory(root);
        if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Data directory must be a real directory, not a link.");
        Directory.CreateDirectory(DirectoryPath);
        if ((File.GetAttributes(DirectoryPath) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Logs directory must not be a link.");
    }

    internal void Write(string message)
    {
        lock (gate)
        {
            try
            {
                Prepare();
                string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message.Replace("\r", " ").Replace("\n", " ");
                if (line.Length > 8192) line = line.Substring(0, 8192) + " [truncated]";
                byte[] bytes = Encoding.UTF8.GetBytes(line + Environment.NewLine);
                string previous = file + ".1";
                if (File.Exists(previous) && new FileInfo(previous).Length > Limit) File.Delete(previous);
                if (File.Exists(file) && new FileInfo(file).Length + bytes.Length > Limit)
                {
                    if (File.Exists(previous)) File.Delete(previous);
                    if (new FileInfo(file).Length <= Limit) File.Move(file, previous);
                    else File.Delete(file);
                }
                using (FileStream stream = new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                    stream.Write(bytes, 0, bytes.Length);
                Failure = null;
            }
            catch (Exception error) { Failure = "Cannot write logs: " + error.Message; }
        }
    }

    internal string ReadRecent()
    {
        lock (gate)
        {
            Prepare();
            if (!File.Exists(file)) return "No log entries yet.";
            using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                if (stream.Length > 200 * 1024) stream.Seek(-200 * 1024, SeekOrigin.End);
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8)) return reader.ReadToEnd();
            }
        }
    }
}

internal sealed class LauncherForm : Form
{
    private readonly string dataDir;
    private readonly BoundedLog log;
    private readonly Label statusLabel;
    private readonly Button launchButton;
    private readonly Button safeButton;
    private readonly Button stopButton;
    private readonly ToolStripMenuItem trayStop;
    private readonly NotifyIcon tray;
    private readonly System.Windows.Forms.Timer stopReminder;
    private Process child;
    private bool stopping;
    private bool exiting;
    private bool allowClose;
    private bool hadError;
    private string errorMessage;
    private string lastMessage;
    private string lastState;

    internal LauncherForm(string directory)
    {
        dataDir = directory;
        log = new BoundedLog(dataDir);
        Text = "Teams Custom";
        Icon = SystemIcons.Application;
        MinimumSize = new Size(660, 410);
        Size = new Size(760, 460);
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = SystemFonts.MessageBoxFont;
        AutoScroll = true;

        TableLayoutPanel layout = new TableLayoutPanel();
        layout.Dock = DockStyle.Top;
        layout.AutoSize = true;
        layout.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        layout.Padding = new Padding(16);
        layout.ColumnCount = 1;
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowCount = 5;
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 110));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        Controls.Add(layout);
        Label heading = new Label();
        heading.Text = "Teams Custom";
        heading.Font = new Font(Font, FontStyle.Bold);
        heading.AutoSize = true;
        heading.Margin = new Padding(0, 0, 0, 12);
        layout.Controls.Add(heading);
        statusLabel = new Label();
        statusLabel.Dock = DockStyle.Fill;
        statusLabel.AutoEllipsis = true;
        statusLabel.AccessibleName = "Companion status";
        statusLabel.Text = "Stopped. Launch Teams to enable customization.";
        layout.Controls.Add(statusLabel);
        FlowLayoutPanel actions = new FlowLayoutPanel();
        actions.AutoSize = true;
        actions.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        actions.Dock = DockStyle.Fill;
        launchButton = Button("&Launch Teams", delegate { Launch(false); });
        safeButton = Button("Launch in &safe mode", delegate { Launch(true); });
        stopButton = Button("S&top Customization", delegate { Stop(); });
        stopButton.Enabled = false;
        actions.Controls.AddRange(new Control[] { launchButton, safeButton, stopButton });
        layout.Controls.Add(actions);
        Label warning = new Label();
        warning.Dock = DockStyle.Fill;
        warning.AutoSize = true;
        warning.Text = "If stock Teams is already running, use its tray menu > Quit before launching here. Nothing will terminate Teams or interrupt a call.\r\n\r\nOnly load trusted extensions. The Teams debugger is accessible to local processes until Teams quits. Stop removes reachable customization; Quit Teams for guaranteed rollback and debugger closure.\r\n\r\nClosing this window hides it to the tray. Choose Exit to stop the companion.";
        warning.Padding = new Padding(0, 12, 0, 8);
        layout.Controls.Add(warning);
        FlowLayoutPanel utilities = new FlowLayoutPanel();
        utilities.AutoSize = true;
        utilities.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        utilities.Dock = DockStyle.Fill;
        utilities.Controls.Add(Button("Open &extensions / data", delegate { OpenData(); }));
        utilities.Controls.Add(Button("View &logs", delegate { ViewLogs(); }));
        utilities.Controls.Add(Button("E&xit", delegate { ExitLauncher(); }));
        layout.Controls.Add(utilities);

        Load += delegate
        {
            // Measure after WinForms scaling; smaller windows retain native scrolling.
            int preferredHeight = layout.GetPreferredSize(new Size(ClientSize.Width, 0)).Height;
            int availableHeight = Screen.FromControl(this).WorkingArea.Height - (Height - ClientSize.Height);
            ClientSize = new Size(ClientSize.Width, Math.Min(preferredHeight, availableHeight));
        };

        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("Show Teams Custom", null, delegate { ShowLauncher(); });
        trayStop = new ToolStripMenuItem("Stop Customization", null, delegate { Stop(); });
        trayStop.Enabled = false;
        menu.Items.Add(trayStop);
        menu.Items.Add("Exit", null, delegate { ExitLauncher(); });
        tray = new NotifyIcon();
        tray.Icon = Icon;
        tray.Text = "Teams Custom — stopped";
        tray.ContextMenuStrip = menu;
        tray.Visible = true;
        tray.DoubleClick += delegate { ShowLauncher(); };
        stopReminder = new System.Windows.Forms.Timer();
        stopReminder.Interval = 15000;
        stopReminder.Tick += delegate
        {
            stopReminder.Stop();
            SetStatus("stopping", "Still waiting for graceful cleanup. Teams is not being terminated. Keep this launcher open; View logs for details.");
            ShowLauncher();
        };
        FormClosing += OnClosing;
        FormClosed += delegate
        {
            stopReminder.Dispose();
            tray.Visible = false;
            tray.Dispose();
            menu.Dispose();
            if (child != null)
            {
                try { child.StandardInput.Close(); } catch (Exception) { }
            }
        };
    }

    private static Button Button(string text, EventHandler handler)
    {
        Button button = new Button();
        button.Text = text;
        button.AutoSize = true;
        button.Padding = new Padding(6, 4, 6, 4);
        button.Click += handler;
        return button;
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == Program.ShowMessage) ShowLauncher();
        base.WndProc(ref message);
    }

    private void ShowLauncher()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void Ui(Action action)
    {
        if (!IsDisposed && IsHandleCreated)
        {
            try { BeginInvoke(action); }
            catch (InvalidOperationException) { }
        }
    }

    private void SetStatus(string state, string message)
    {
        lastMessage = message;
        lastState = state;
        statusLabel.Text = state.ToUpperInvariant() + ": " + message;
        statusLabel.ForeColor = state == "error" ? Color.Firebrick : SystemColors.ControlText;
        tray.Text = "Teams Custom — " + state;
    }

    private void Error(string message)
    {
        hadError = true;
        errorMessage = message;
        log.Write("ERROR " + message);
        SetStatus("error", message);
        ShowLauncher();
    }

    private void SetActive(bool active)
    {
        launchButton.Enabled = !active && !exiting;
        safeButton.Enabled = !active && !exiting;
        stopButton.Enabled = active && !stopping;
        trayStop.Enabled = stopButton.Enabled;
    }

    private void Launch(bool safeMode)
    {
        if (child != null || exiting) return;
        hadError = false;
        errorMessage = null;
        stopping = false;
        Process launched = null;
        try
        {
            log.Prepare();
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string node = Path.Combine(root, "runtime", "node.exe");
            string script = Path.Combine(root, "app", "index.js");
            if (!File.Exists(node) || !File.Exists(script))
                throw new FileNotFoundException("Bundled runtime or app is missing. Reinstall Teams Custom or extract the complete portable ZIP.");
            log.Write("Launching companion" + (safeMode ? " in SAFE MODE" : "") + "; data: " + dataDir);
            if (log.Failure != null) throw new IOException(log.Failure);
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = node;
            info.WorkingDirectory = Path.Combine(root, "app");
            info.Arguments = Program.Quote(script) + " --managed --data-dir " + Program.Quote(dataDir) + (safeMode ? " --safe-mode" : "");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;
            launched = new Process();
            launched.StartInfo = info;
            if (!launched.Start()) throw new IOException("Could not start the bundled companion.");
            child = launched;
            SetActive(true);
            SetStatus("starting", safeMode ? "Starting in safe mode; extensions will not run." : "Starting Teams companion.");
            CountdownEvent readers = new CountdownEvent(2);
            Process current = launched;
            ThreadPool.QueueUserWorkItem(delegate { ReadLines(current.StandardOutput, current, true, readers); });
            ThreadPool.QueueUserWorkItem(delegate { ReadLines(current.StandardError, current, false, readers); });
            ThreadPool.QueueUserWorkItem(delegate
            {
                int code = -1;
                try { current.WaitForExit(); code = current.ExitCode; }
                catch (Exception error) { log.Write("Process wait failed: " + error.Message); }
                readers.Wait();
                readers.Dispose();
                int exitCode = code;
                Ui(delegate { ChildExited(current, exitCode); });
            });
        }
        catch (Exception error)
        {
            if (launched != null && child == null) launched.Dispose();
            SetActive(child != null);
            Error(error.Message);
        }
    }

    // Bounded line readers keep malformed child output from growing memory or logs indefinitely.
    private void ReadLines(StreamReader reader, Process current, bool protocol, CountdownEvent completion)
    {
        try
        {
            char[] buffer = new char[4096];
            StringBuilder line = new StringBuilder();
            bool overflow = false;
            int count;
            while ((count = reader.Read(buffer, 0, buffer.Length)) > 0)
            {
                for (int i = 0; i < count; i++)
                {
                    char character = buffer[i];
                    if (character == '\n')
                    {
                        if (!overflow) HandleLine(line.ToString().TrimEnd('\r'), current, protocol);
                        line.Length = 0;
                        overflow = false;
                    }
                    else if (!overflow)
                    {
                        if (line.Length == 8192)
                        {
                            line.Length = 0;
                            overflow = true;
                            log.Write("Discarded oversized child output line.");
                            if (protocol) Ui(delegate { if (child == current) Error("Companion emitted an oversized protocol record. Stop and reinstall the application."); });
                        }
                        else line.Append(character);
                    }
                }
            }
            if (line.Length != 0 && !overflow) HandleLine(line.ToString().TrimEnd('\r'), current, protocol);
        }
        catch (Exception error)
        {
            log.Write("Child stream error: " + error.Message);
            Ui(delegate { if (child == current) Error("Companion output could not be read: " + error.Message); });
        }
        finally { completion.Signal(); }
    }

    private void HandleLine(string line, Process current, bool protocol)
    {
        if (line.Length == 0) return;
        log.Write((protocol ? "STATUS " : "LOG ") + line);
        string logFailure = log.Failure;
        if (logFailure != null) Ui(delegate { if (child == current) Error(logFailure); });
        if (!protocol) return;
        try
        {
            JavaScriptSerializer parser = new JavaScriptSerializer();
            parser.MaxJsonLength = 8192;
            parser.RecursionLimit = 8;
            Dictionary<string, object> record = parser.Deserialize<Dictionary<string, object>>(line);
            object version, stateValue, messageValue, portValue;
            if (record == null || !record.TryGetValue("protocol", out version) || !(version is int) || (int)version != 1
                || !record.TryGetValue("state", out stateValue) || !(stateValue is string)
                || !record.TryGetValue("message", out messageValue) || !(messageValue is string))
                throw new FormatException("Invalid status record.");
            string state = (string)stateValue;
            if (state != "starting" && state != "running" && state != "waiting" && state != "stopping" && state != "stopped" && state != "error")
                throw new FormatException("Unknown status state.");
            if (record.TryGetValue("port", out portValue) && (!(portValue is int) || (int)portValue < 1 || (int)portValue > 65535))
                throw new FormatException("Invalid status port.");
            string message = (string)messageValue;
            Ui(delegate
            {
                if (child != current) return;
                if (state == "error") Error(message);
                else if (!hadError && !(stopping && (state == "starting" || state == "running" || state == "waiting"))) SetStatus(state, message);
            });
        }
        catch (Exception error)
        {
            Ui(delegate { if (child == current) Error("Companion protocol error: " + error.Message); });
        }
    }

    private void ChildExited(Process current, int code)
    {
        if (child != current) return;
        child = null;
        current.Dispose();
        stopReminder.Stop();
        log.Write("Companion exited with code " + code);
        if (code != 0 && !hadError) Error("Companion exited with code " + code + ". View logs for details; launch again to retry.");
        else if (hadError) SetStatus("error", errorMessage + " Launch again to retry; View logs for details.");
        else SetStatus("stopped", lastState == "stopped" ? lastMessage : "Companion stopped. Teams was not terminated; Quit Teams to close its debugger.");
        stopping = false;
        SetActive(false);
        if (exiting)
        {
            if (hadError)
            {
                exiting = false;
                SetActive(false);
                ShowLauncher();
            }
            else { allowClose = true; Close(); }
        }
    }

    private void Stop()
    {
        if (child == null || stopping) return;
        stopping = true;
        SetActive(true);
        SetStatus("stopping", "Removing reachable customization. Teams is not being terminated; its debugger closes only when Teams quits.");
        log.Write("Requesting graceful stop.");
        try
        {
            child.StandardInput.WriteLine("stop");
            child.StandardInput.Flush();
            child.StandardInput.Close();
        }
        catch (Exception error)
        {
            // Closing the pipe is the second graceful channel; no forced process termination.
            try { child.StandardInput.Close(); } catch (Exception) { }
            Error("Could not send stop; closed parent input for EOF cleanup: " + error.Message);
        }
        stopReminder.Start();
    }

    private void ExitLauncher()
    {
        if (child == null) { allowClose = true; Close(); return; }
        exiting = true;
        Stop();
        ShowLauncher();
    }

    private void OnClosing(object sender, FormClosingEventArgs args)
    {
        if (allowClose) return;
        if (args.CloseReason == CloseReason.WindowsShutDown || args.CloseReason == CloseReason.TaskManagerClosing)
        {
            Stop();
            return;
        }
        args.Cancel = true;
        Hide();
    }

    private void OpenData()
    {
        try
        {
            log.Prepare();
            Directory.CreateDirectory(Path.Combine(dataDir, "themes"));
            Directory.CreateDirectory(Path.Combine(dataDir, "plugins"));
            Process.Start(new ProcessStartInfo(dataDir) { UseShellExecute = true });
        }
        catch (Exception error) { Error("Cannot open data folder: " + error.Message); }
    }

    private void ViewLogs()
    {
        try
        {
            Form viewer = new Form();
            viewer.Text = "Teams Custom — recent logs (" + log.DirectoryPath + ")";
            viewer.Size = new Size(900, 600);
            viewer.StartPosition = FormStartPosition.CenterParent;
            TextBox text = new TextBox();
            text.Multiline = true;
            text.ReadOnly = true;
            text.ScrollBars = ScrollBars.Both;
            text.WordWrap = false;
            text.Dock = DockStyle.Fill;
            text.Font = new Font(FontFamily.GenericMonospace, 10);
            text.Text = log.ReadRecent();
            FlowLayoutPanel actions = new FlowLayoutPanel();
            actions.Dock = DockStyle.Bottom;
            actions.AutoSize = true;
            actions.Controls.Add(Button("&Refresh", delegate
            {
                try { text.Text = log.ReadRecent(); text.SelectionStart = text.TextLength; text.ScrollToCaret(); }
                catch (Exception error) { MessageBox.Show(viewer, error.Message, "Cannot read logs", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            }));
            actions.Controls.Add(Button("Open log &folder", delegate
            {
                try { Process.Start(new ProcessStartInfo(log.DirectoryPath) { UseShellExecute = true }); }
                catch (Exception error) { MessageBox.Show(viewer, error.Message, "Cannot open logs", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            }));
            viewer.Controls.Add(text);
            viewer.Controls.Add(actions);
            viewer.Show(this);
            text.SelectionStart = text.TextLength;
            text.ScrollToCaret();
        }
        catch (Exception error) { Error("Cannot view logs: " + error.Message); }
    }
}
