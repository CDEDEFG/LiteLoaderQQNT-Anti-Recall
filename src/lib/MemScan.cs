using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

// QQ 的 SQLCipher 密钥在进程内存里以 hex 字符串形式存在：
//     x'<64 hex 原始 32 字节 AES key><32 hex 本库 salt>'
// 只要找到尾部 32 hex 等于目标库 salt 的那条，前面的 64 hex 就是这个库的 key。
//
// 关键前提：只有加载了 wrapper.node 的那个 QQ 进程里才有这些字符串。
public class QQKeyScan
{
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MEMORY_BASIC_INFORMATION64 mbi, IntPtr len);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORY_BASIC_INFORMATION64
    {
        public ulong BaseAddress;
        public ulong AllocationBase;
        public uint AllocationProtect;
        public uint Pad1;
        public ulong RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
        public uint Pad2;
    }

    const uint PROCESS_VM_READ = 0x0010;
    const uint PROCESS_QUERY_INFORMATION = 0x0400;
    const uint MEM_COMMIT = 0x1000;
    const uint PAGE_GUARD = 0x100;
    const uint PAGE_NOACCESS = 0x01;

    // 96 个 hex 前面紧跟 x' 或 x"（大小写都算）
    static readonly Regex BlobRe = new Regex(@"x['""]([0-9a-fA-F]{96})['""]", RegexOptions.Compiled);

    /// <summary>
    /// 扫描一个进程，返回匹配给定 salt 集合的 key blob。
    /// salts: 小写 hex 的 32 字符串集合（每个库一个）
    /// </summary>
    public static string Scan(int pid, string[] salts)
    {
        var want = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var s in salts) if (!string.IsNullOrEmpty(s)) want.Add(s.ToLowerInvariant());

        IntPtr h = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid);
        if (h.ToInt64() == 0) return "OPEN_FAIL:" + Marshal.GetLastWin32Error();

        var results = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long addr = 0x10000;               // 跳过最低 64KB（保留区）
        long totalRead = 0;
        int regions = 0;

        var mbi = new MEMORY_BASIC_INFORMATION64();
        int msz = Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION64));
        byte[] chunk = new byte[4 * 1024 * 1024];
        byte[] carry = new byte[4096];
        int carryLen = 0;

        while (addr < 0x7FFFFFFF0000L)
        {
            IntPtr q = VirtualQueryEx(h, new IntPtr(addr), out mbi, new IntPtr(msz));
            if (q.ToInt64() == 0) break;
            ulong baseA = mbi.BaseAddress;
            ulong size = mbi.RegionSize;
            if (size == 0) break;

            uint prot = mbi.Protect & 0xFF;
            bool readable = mbi.State == MEM_COMMIT && prot != PAGE_NOACCESS && (mbi.Protect & PAGE_GUARD) == 0;

            if (readable && size <= 536870912UL)
            {
                long remain = (long)size;
                long cur = (long)baseA;
                while (remain > 0)
                {
                    int ask = (int)Math.Min(remain, (long)chunk.Length);
                    IntPtr got;
                    if (!ReadProcessMemory(h, new IntPtr(cur), chunk, new IntPtr(ask), out got)) break;
                    int n = got.ToInt32();
                    if (n <= 0) break;
                    totalRead += n;

                    // 拼上上一块的尾巴，避免 blob 跨块被切断
                    int buflen = n + carryLen;
                    byte[] buf = new byte[buflen];
                    Buffer.BlockCopy(carry, 0, buf, 0, carryLen);
                    Buffer.BlockCopy(chunk, 0, buf, carryLen, n);

                    string text = Encoding.GetEncoding(28591).GetString(buf); // Latin-1：字节与字符一一对应
                    foreach (Match m in BlobRe.Matches(text))
                    {
                        string hex = m.Groups[1].Value;
                        string salt = hex.Substring(64, 32).ToLowerInvariant();
                        if (!want.Contains(salt)) continue;
                        string key = hex.Substring(0, 64).ToLowerInvariant();
                        string id = key + salt;
                        if (!seen.Add(id)) continue;
                        results.Add(key + " " + salt);
                    }

                    int keep = Math.Min(carry.Length, buflen);
                    Buffer.BlockCopy(buf, buflen - keep, carry, 0, keep);
                    carryLen = keep;

                    cur += n;
                    remain -= n;
                }
                regions++;
            }

            ulong next = baseA + size;
            if (next <= baseA) break;
            addr = (long)next;
        }
        CloseHandle(h);

        var sb = new StringBuilder();
        sb.Append("STATS:").Append(regions).Append(':').Append(totalRead / 1048576);
        foreach (var r in results) sb.Append('\n').Append(r);
        return sb.ToString();
    }
}
