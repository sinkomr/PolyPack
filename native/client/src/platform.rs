//! What depends on the operating system: thread priority, the power source, process liveness and the console window.

/// Lower the calling thread's CPU priority. On Linux each thread has its own nice value; on macOS
/// this lowers the whole process, which only lowers the idle main thread as well; on Windows the
/// thread runs at idle priority.
pub fn lower_thread_priority() {
    #[cfg(unix)]
    unsafe {
        // SAFETY: setpriority only reads its arguments; failure leaves the priority as it was.
        libc::setpriority(libc::PRIO_PROCESS, 0, 19);
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_IDLE};
        // SAFETY: the pseudo-handle of the current thread needs no closing; failure changes nothing.
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_IDLE);
    }
}

#[allow(dead_code)]
/// macOS `pmset -g batt`: the first line names the power source. True on 'Battery Power' and
/// 'UPS Power'; false on 'AC Power' and anything unrecognised.
pub fn on_battery_from_pmset(output: &str) -> bool {
    let Some(start) = output.find("Now drawing from '") else { return false };
    let rest = &output[start + "Now drawing from '".len()..];
    let Some(end) = rest.find('\'') else { return false };
    matches!(&rest[..end], "Battery Power" | "UPS Power")
}

#[allow(dead_code)]
/// Linux power supplies (name, type, online): on battery when there is a battery and external
/// supplies, none of them online. Without any external supply listed, AC.
pub fn on_battery_from_supplies(supplies: &[(String, String, Option<String>)]) -> bool {
    let external: Vec<_> = supplies.iter().filter(|s| s.1.trim() != "Battery" && s.2.is_some()).collect();
    let battery = supplies.iter().any(|s| s.1.trim() == "Battery");
    if !battery || external.is_empty() {
        return false;
    }
    !external.iter().any(|s| s.2.as_deref().unwrap_or("0").trim().parse::<i64>().unwrap_or(0) > 0)
}

/// True when the machine is known to run on battery power; anything unknown counts as AC.
pub fn on_battery() -> bool {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("pmset").args(["-g", "batt"]).output() {
            return on_battery_from_pmset(&String::from_utf8_lossy(&out.stdout));
        }
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        let mut supplies = Vec::new();
        if let Ok(dir) = std::fs::read_dir("/sys/class/power_supply") {
            for entry in dir.flatten() {
                let path = entry.path();
                let Ok(kind) = std::fs::read_to_string(path.join("type")) else { continue };
                let online = std::fs::read_to_string(path.join("online")).ok();
                supplies.push((entry.file_name().to_string_lossy().to_string(), kind, online));
            }
        }
        return on_battery_from_supplies(&supplies);
    }
    #[allow(unreachable_code)]
    false
}

/// Whether a process with this pid exists on this machine (unknown counts as alive).
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the process exists.
        let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
        if rc == 0 {
            return true;
        }
        return std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        // SAFETY: OpenProcess only reads its arguments; the handle it returns is closed below.
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // no process has this id; any other failure (access denied: another user's process) counts as alive
            return GetLastError() != ERROR_INVALID_PARAMETER;
        }
        let mut code: u32 = 0;
        // SAFETY: the handle is open and `code` outlives the call.
        let read = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        // a process that has ended but is still held open by someone has its exit code; an unreadable one counts as alive
        return read == 0 || code == STILL_ACTIVE as u32;
    }
    #[allow(unreachable_code)]
    {
        let _ = pid;
        true
    }
}

/// True when this process is the only one attached to its console window: Windows opened the window
/// for it, as when the program is started by double-clicking it, and closes it as soon as the program
/// ends. False elsewhere, and when the program runs in PowerShell or a Command Prompt.
pub fn console_is_own() -> bool {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Console::GetConsoleProcessList;
        let mut ids = [0u32; 2];
        // SAFETY: the call writes at most `ids.len()` process ids into `ids`.
        return GetConsoleProcessList(ids.as_mut_ptr(), ids.len() as u32) == 1;
    }
    #[allow(unreachable_code)]
    false
}

pub fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: gethostname writes at most buf.len() bytes.
        let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if rc == 0 {
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            return String::from_utf8_lossy(&buf[..end]).to_string();
        }
    }
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "unknown".into())
}

pub fn available_parallelism() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
}

pub fn home_dir() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// The id of a process that has ended and was waited for, so that no process has it (for tests).
#[cfg(test)]
pub fn ended_pid() -> u32 {
    #[cfg(windows)]
    let mut child = std::process::Command::new("cmd").args(["/C", "exit 0"]).spawn().unwrap();
    #[cfg(not(windows))]
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    pid
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn power_sources() {
        assert!(on_battery_from_pmset("Now drawing from 'Battery Power'\n -InternalBattery-0 87%"));
        assert!(!on_battery_from_pmset("Now drawing from 'AC Power'\n"));
        assert!(!on_battery_from_pmset(""));
        let s = |n: &str, t: &str, o: Option<&str>| (n.to_string(), t.to_string(), o.map(|x| x.to_string()));
        assert!(on_battery_from_supplies(&[s("BAT0", "Battery", None), s("AC", "Mains", Some("0\n"))]));
        assert!(!on_battery_from_supplies(&[s("BAT0", "Battery", None), s("AC", "Mains", Some("1\n"))]));
        assert!(!on_battery_from_supplies(&[s("BAT0", "Battery", None)]));
    }

    #[test]
    fn a_running_process_is_alive_and_an_ended_one_is_not() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(ended_pid()));
    }
}
