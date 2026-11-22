// Pizza Room - kitchen ticket printer helper (ESC/POS raster, 80 mm)
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;

public static class PRPrint
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool OpenPrinter(string name, out IntPtr h, IntPtr def);
    [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
    [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
    [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
    [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
    [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] buf, int len, out int written);

    public static void Raw(string printer, byte[] data, string docName)
    {
        IntPtr h;
        if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Printer not found: " + printer + " (" + Marshal.GetLastWin32Error() + ")");
        try
        {
            DOCINFO di = new DOCINFO(); di.pDocName = docName; di.pDataType = "RAW";
            if (StartDocPrinter(h, 1, di) == 0) throw new Exception("StartDoc failed " + Marshal.GetLastWin32Error());
            StartPagePrinter(h);
            int w; bool ok = WritePrinter(h, data, data.Length, out w);
            EndPagePrinter(h); EndDocPrinter(h);
            if (!ok || w != data.Length) throw new Exception("Write failed " + Marshal.GetLastWin32Error());
        }
        finally { ClosePrinter(h); }
    }

    // texts/sizes(pt)/bold/align("c","r","")/line/inv - one entry per ticket line
    public static Bitmap Draw(string[] texts, float[] sizes, bool[] bold, string[] align, bool[] line, bool[] inv, string fontName, int width)
    {
        int pad = 8, W = width; int n = texts.Length;
        float[] hs = new float[n];
        StringFormat[] fm = new StringFormat[n];
        using (Bitmap tmp = new Bitmap(10, 10)) using (Graphics g0 = Graphics.FromImage(tmp))
        {
            g0.TextRenderingHint = TextRenderingHint.SingleBitPerPixelGridFit;
            for (int i = 0; i < n; i++)
            {
                StringFormat f = new StringFormat();
                f.Alignment = align[i] == "c" ? StringAlignment.Center : align[i] == "r" ? StringAlignment.Far : StringAlignment.Near;
                fm[i] = f;
                if (line[i]) { hs[i] = 18; continue; }
                using (Font ft = new Font(fontName, sizes[i] * 2.8f, bold[i] ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel))
                {
                    SizeF sz = g0.MeasureString(texts[i] ?? "", ft, W - pad * 2 - (inv[i] ? 16 : 0), f);
                    hs[i] = (float)Math.Ceiling(sz.Height) + (inv[i] ? 12 : 4);
                }
            }
        }
        float total = 10; foreach (float x in hs) total += x;
        Bitmap bmp = new Bitmap(W, (int)Math.Ceiling(total) + 10);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.White);
            g.TextRenderingHint = TextRenderingHint.SingleBitPerPixelGridFit;
            g.SmoothingMode = SmoothingMode.None;
            float y = 10;
            for (int i = 0; i < n; i++)
            {
                if (line[i])
                {
                    using (Pen p = new Pen(Color.Black, 2)) { p.DashStyle = DashStyle.Dash; g.DrawLine(p, pad, y + 8, W - pad, y + 8); }
                    y += hs[i]; continue;
                }
                using (Font ft = new Font(fontName, sizes[i] * 2.8f, bold[i] ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel))
                {
                    if (inv[i])
                    {
                        g.FillRectangle(Brushes.Black, pad, y, W - pad * 2, hs[i] - 2);
                        g.DrawString(texts[i] ?? "", ft, Brushes.White, new RectangleF(pad + 8, y + 5, W - pad * 2 - 16, hs[i]), fm[i]);
                    }
                    else g.DrawString(texts[i] ?? "", ft, Brushes.Black, new RectangleF(pad, y, W - pad * 2, hs[i]), fm[i]);
                }
                y += hs[i];
            }
        }
        return bmp;
    }

    public static byte[] EscPos(Bitmap bmp, bool cut, int feed)
    {
        int W = bmp.Width, H = bmp.Height, bw = (W + 7) / 8;
        MemoryStream ms = new MemoryStream();
        ms.Write(new byte[] { 0x1B, 0x40 }, 0, 2); // init
        BitmapData d = bmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        byte[] px = new byte[d.Stride * H]; Marshal.Copy(d.Scan0, px, 0, px.Length); int stride = d.Stride; bmp.UnlockBits(d);
        for (int y0 = 0; y0 < H; y0 += 200)
        {
            int rows = Math.Min(200, H - y0);
            ms.Write(new byte[] { 0x1D, 0x76, 0x30, 0x00, (byte)(bw & 255), (byte)(bw >> 8), (byte)(rows & 255), (byte)(rows >> 8) }, 0, 8);
            byte[] band = new byte[bw * rows];
            for (int y = 0; y < rows; y++)
                for (int x = 0; x < W; x++)
                {
                    int o = (y0 + y) * stride + x * 4;
                    int lum = (px[o] * 11 + px[o + 1] * 59 + px[o + 2] * 30) / 100;
                    if (lum < 128) band[y * bw + (x >> 3)] |= (byte)(0x80 >> (x & 7));
                }
            ms.Write(band, 0, band.Length);
        }
        ms.Write(new byte[] { 0x1B, 0x64, (byte)feed }, 0, 3);
        if (cut) ms.Write(new byte[] { 0x1D, 0x56, 0x42, 0x00 }, 0, 4);
        return ms.ToArray();
    }

    public static void Ticket(string printer, string[] texts, float[] sizes, bool[] bold, string[] align, bool[] line, bool[] inv, string fontName, int width, bool cut, string docName)
    {
        using (Bitmap b = Draw(texts, sizes, bold, align, line, inv, fontName, width)) Raw(printer, EscPos(b, cut, 4), docName);
    }

    public static void Preview(string file, string[] texts, float[] sizes, bool[] bold, string[] align, bool[] line, bool[] inv, string fontName, int width)
    {
        using (Bitmap b = Draw(texts, sizes, bold, align, line, inv, fontName, width)) b.Save(file, ImageFormat.Png);
    }
}
