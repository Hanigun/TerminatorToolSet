"""Generate assets/icons/app_icon.ico and app_icon.png (Terminator eye)."""
import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
S = 1024  # supersampled canvas


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def main():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # dark rounded background
    bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bg)
    bd.rounded_rectangle([16, 16, S - 16, S - 16], radius=180, fill=(26, 28, 32, 255))
    img.alpha_composite(bg)

    d = ImageDraw.Draw(img)
    # subtle border
    d.rounded_rectangle([16, 16, S - 16, S - 16], radius=180,
                        outline=(70, 76, 88, 255), width=10)

    # red eye glow (radial)
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    cx, cy = S // 2, S // 2
    for r, alpha in ((380, 40), (300, 70), (230, 110)):
        gd.ellipse([cx - r, cy - int(r * 0.62), cx + r, cy + int(r * 0.62)],
                   fill=(226, 88, 74, alpha))
    glow = glow.filter(ImageFilter.GaussianBlur(70))
    img.alpha_composite(glow)

    d = ImageDraw.Draw(img)
    # eyelid shape (wide lens)
    lid = [(cx - 330, cy), (cx - 150, cy - 165), (cx + 150, cy - 165), (cx + 330, cy),
           (cx + 150, cy + 165), (cx - 150, cy + 165)]
    d.polygon(lid, fill=(12, 12, 14, 255), outline=(120, 40, 36, 255), width=8)

    # iris ring
    rr = 118
    d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(40, 8, 8, 255),
              outline=(226, 88, 74, 255), width=14)
    # pupil bright core
    pr = 58
    d.ellipse([cx - pr, cy - pr, cx + pr, cy + pr], fill=(255, 120, 96, 255))
    d.ellipse([cx - 26, cy - 26, cx + 26, cy + 26], fill=(255, 214, 200, 255))

    # horizontal scan line across the eye
    scan = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(scan)
    sd.rectangle([cx - 340, cy - 6, cx + 340, cy + 6], fill=(255, 90, 70, 200))
    scan = scan.filter(ImageFilter.GaussianBlur(4))
    img.alpha_composite(scan)

    # re-clip everything to the rounded square
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([16, 16, S - 16, S - 16], radius=180, fill=255)
    final = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    final.paste(img, (0, 0), mask)

    out_png = os.path.join(HERE, "app_icon.png")
    final.resize((256, 256), Image.LANCZOS).save(out_png)

    out_ico = os.path.join(HERE, "app_icon.ico")
    final.save(out_ico, format="ICO",
               sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    print("written:", out_png, out_ico)


if __name__ == "__main__":
    main()
