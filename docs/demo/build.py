# Annotates real captures from docs/demo/src into 1280x720 frames (docs/demo/frame-NN.png).
# Usage: python3 -I docs/demo/build.py   (from repo root)
from PIL import Image, ImageDraw, ImageFont
import os
S='docs/demo/src/'; O='docs/demo/'
RED=(255,26,46); GB=(63,224,138); BG=(18,22,25)
# (file, crop_y, caption, box in full 1280x900 coords)
F=[
('sell-form.png',180,'SELLER LISTS',(118,776,326,808)),
('market-buyer-sees-listing.png',0,'BUYER FINDS',(118,332,370,620)),
('chat-buyer-started.png',0,'BUYER OPENS PRIVATE CHAT',(396,324,780,450)),
('invite-seller.png',0,'SELLER ACCEPTS INVITE',(122,334,366,372)),
('chat-seller-messages.png',0,'PRIVATE MESSAGES',(396,466,1150,650)),
('pay-token-created.png',180,'BUYER PAYS WITH ECASH',(630,842,802,868)),
('redeem-button.png',180,'SELLER REDEEMS',(394,748,568,774)),
('redeemed-paid-seller.png',0,'PAID',(394,290,930,452)),
('persist-buyer.png',0,'REOPEN: ORDER PERSISTS',(396,290,930,452)),
]
mono=lambda n:ImageFont.truetype('/System/Library/Fonts/Menlo.ttc',n,index=1)
for i,(f,cy,cap,b) in enumerate(F,1):
    im=Image.open(S+f).convert('RGB').crop((0,cy,1280,cy+720))
    d=ImageDraw.Draw(im,'RGBA')
    x0,y0,x1,y1=b[0],b[1]-cy,b[2],b[3]-cy
    for k in range(3): d.rectangle((x0-k,y0-k,x1+k,y1+k),outline=RED)
    r=15; cx,cy2=x1+2,y0-2
    d.ellipse((cx-r,cy2-r,cx+r,cy2+r),fill=RED)
    fn=mono(20); d.text((cx,cy2),str(i),font=fn,fill=(255,255,255),anchor='mm')
    # caption pill bottom-left
    t=f'{i} {cap}'; ft=mono(26); w=d.textlength(t,font=ft)
    d.rectangle((0,720-58,w+48,720),fill=BG+(240,))
    d.rectangle((0,720-58,6,720),fill=RED)
    d.text((24,720-29),t,font=ft,fill=GB,anchor='lm')
    im.save(O+f'frame-{i:02d}.png')
