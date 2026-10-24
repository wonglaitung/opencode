from pathlib import Path
from PIL import Image, ImageDraw

img = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Head
d.ellipse([45, 10, 155, 110], fill=(245, 245, 245, 255), outline=(180, 180, 180, 255), width=3)
# Face screen
d.rounded_rectangle([70, 25, 130, 75], radius=18, fill=(26, 26, 26, 255))
# Left eye
d.ellipse([78, 35, 102, 59], fill=(0, 255, 255, 220))
d.ellipse([82, 39, 98, 55], fill=(0, 153, 255, 255))
d.ellipse([88, 43, 92, 49], fill=(255, 255, 255, 255))
# Right eye
d.ellipse([98, 35, 122, 59], fill=(0, 255, 255, 220))
d.ellipse([102, 39, 118, 55], fill=(0, 153, 255, 255))
d.ellipse([108, 43, 112, 49], fill=(255, 255, 255, 255))
# Head side ears
d.ellipse([32, 40, 50, 72], fill=(224, 224, 224, 255), outline=(180, 180, 180, 255))
d.ellipse([150, 40, 168, 72], fill=(224, 224, 224, 255), outline=(180, 180, 180, 255))
# Neck
d.rectangle([118, 85, 138, 100], fill=(200, 200, 200, 255))
# Body
d.ellipse([65, 98, 191, 178], fill=(245, 245, 245, 255), outline=(180, 180, 180, 255), width=3)
# Body blue curve
d.arc([95, 118, 161, 152], start=200, end=340, fill=(0, 204, 255, 180), width=4)
# Body center dot
d.ellipse([124, 130, 132, 138], fill=(0, 204, 255, 200))
# Left arm (waving up)
d.rounded_rectangle([22, 55, 55, 115], radius=12, fill=(232, 232, 232, 255), outline=(180, 180, 180, 255))
d.ellipse([15, 45, 45, 65], fill=(240, 240, 240, 255), outline=(180, 180, 180, 255))
# Left arm connector
d.ellipse([45, 95, 70, 120], fill=(232, 232, 232, 255), outline=(180, 180, 180, 255))
# Right arm (down)
d.ellipse([186, 95, 211, 120], fill=(232, 232, 232, 255), outline=(180, 180, 180, 255))
d.rounded_rectangle([201, 110, 228, 160], radius=12, fill=(232, 232, 232, 255), outline=(180, 180, 180, 255))
d.ellipse([205, 155, 225, 170], fill=(240, 240, 240, 255), outline=(180, 180, 180, 255))
# Left leg
d.rounded_rectangle([85, 172, 105, 210], radius=10, fill=(232, 232, 232, 255), outline=(180, 180, 180, 255))
d.ellipse([78, 205, 112, 220], fill=(232, 232, 232, 255), outline=(180, 180, 180, 255))
# Right leg
d.rounded_rectangle([151, 172, 171, 210], radius=10, fill=(232, 232, 232, 255), outline=(180, 180, 180, 255))
d.ellipse([144, 205, 178, 220], fill=(232, 232, 232, 255), outline=(180, 180, 180, 255))

out = str(Path(__file__).with_name("icon.ico"))
img.save(out, format='ICO', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
v = Image.open(out)
px = list(v.getdata())
print('OK size:', v.size, 'center:', px[32896], 'corner:', px[0])
