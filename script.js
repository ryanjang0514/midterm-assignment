(() => {
'use strict';
const $ = id => document.getElementById(id);
const canvas = $('film');
const gl = canvas.getContext('webgl2', {antialias:false, alpha:false, preserveDrawingBuffer:true, powerPreference:'high-performance'});
const okFloat = gl && (gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
if (!gl || !okFloat) { $('fail').hidden = false; return; }

const HN = 1400;          // nm represented by a stored thickness of 1.0
const N_FILM = 1.33;      // soapy water
const OPD_MAX = 4096;     // nm of optical path difference covered by the colour table
const small = matchMedia('(max-width: 820px)').matches;
/* Two forms share one simulation. Flat sheet: the film fills the poster and is pinned on every side.
   Bubble: the film is unwrapped 2:1 (longitude by latitude), wraps around, and is pinned only at the poles. */
let MODE = 'poster';
try { if (localStorage.getItem('thinfilm-form') === 'bubble') MODE = 'bubble'; } catch (e) {}
const GRID = { poster:{vel:small ? 208 : 304, dye:small ? 720 : 1024, text:small ? 1536 : 2048},
               bubble:{vel:small ? 176 : 256, dye:small ? 560 : 832, text:small ? 1024 : 1536} };
const isBubble = () => MODE === 'bubble';
const DA = () => isBubble() ? 2 : S.ar;    /* aspect of the simulation domain */

/* ---------- colour table: spectral integration of the Airy reflectance ---------- */
function lobe(l, mu, s1, s2){ const t = (l - mu) / (l < mu ? s1 : s2); return Math.exp(-0.5 * t * t); }
function cmf(l){ return [
  1.056*lobe(l,599.8,37.9,31.0) + 0.362*lobe(l,442.0,16.0,26.7) - 0.065*lobe(l,501.1,20.4,26.2),
  0.821*lobe(l,568.8,46.9,40.5) + 0.286*lobe(l,530.9,16.3,31.1),
  1.217*lobe(l,437.0,11.8,36.0) + 0.681*lobe(l,459.0,26.0,13.8)]; }
function planck(l, T){ const m = l * 1e-9; return 1 / (Math.pow(m,5) * (Math.exp(1.4388e-2 / (m * T)) - 1)); }
const LUT_N = 2048;
const lut = new Float32Array(LUT_N * 4);
(function buildLut(){
  const r2 = Math.pow((N_FILM - 1) / (N_FILM + 1), 2), r4 = r2 * r2;
  const ls = []; for (let l = 380; l <= 730; l += 5) ls.push(l);
  const S = ls.map(l => planck(l, 6200)), C = ls.map(cmf);
  const toRGB = (X,Y,Z) => [3.2406*X - 1.5372*Y - 0.4986*Z, -0.9689*X + 1.8758*Y + 0.0415*Z, 0.0557*X - 0.2040*Y + 1.0570*Z];
  let wX=0,wY=0,wZ=0; ls.forEach((l,i)=>{ wX+=S[i]*C[i][0]; wY+=S[i]*C[i][1]; wZ+=S[i]*C[i][2]; });
  const white = toRGB(wX/wY, 1, wZ/wY);
  for (let k = 0; k < LUT_N; k++){
    const opd = k / (LUT_N - 1) * OPD_MAX;
    let X=0,Y=0,Z=0;
    for (let i = 0; i < ls.length; i++){
      const c = Math.cos(2 * Math.PI * opd / ls[i]);
      const R = 2 * r2 * (1 - c) / (1 + r4 - 2 * r2 * c) / (4 * r2);
      X += S[i]*C[i][0]*R; Y += S[i]*C[i][1]*R; Z += S[i]*C[i][2]*R;
    }
    const rgb = toRGB(X/wY, Y/wY, Z/wY);
    lut[k*4] = rgb[0]/white[0]; lut[k*4+1] = rgb[1]/white[1]; lut[k*4+2] = rgb[2]/white[2]; lut[k*4+3] = 1;
  }
})();
function tone(c){
  let [r,g,b] = c; const Y = 0.2126*r + 0.7152*g + 0.0722*b, mn = Math.min(r,g,b);
  if (mn < 0){ const k = Y / (Y - mn); r = Y + (r-Y)*k; g = Y + (g-Y)*k; b = Y + (b-Y)*k; }
  return [r,g,b].map(v => Math.pow(1 - Math.exp(-1.3 * Math.max(Y + (v - Y) * 0.84, 0) * 0.9), 1/2.2));
}
(function drawScale(){
  const c = $('scale'), x = c.getContext('2d');
  for (let i = 0; i < c.width; i++){
    const opd = 2 * N_FILM * (i / (c.width - 1)) * HN;
    const k = Math.min(LUT_N - 1, Math.round(opd / OPD_MAX * (LUT_N - 1)));
    const t = tone([lut[k*4], lut[k*4+1], lut[k*4+2]]);
    x.fillStyle = `rgb(${t.map(v => Math.round(v*255)).join(',')})`; x.fillRect(i, 0, 1, c.height);
  }
})();

/* ---------- GL plumbing ---------- */
const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.,1.); }`;
const HEAD = `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 vUv; out vec4 o;
`;
const NOISE = `
float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*f*(f*(f*6.-15.)+10.);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
`;
/* Equilibrium thickness: gravity profile + image relief + letters (black film) + displaced rim. */
const TARGET = `
uniform sampler2D uImg, uMask, uBlur;
uniform float uAge, uHmax, uImgAmt, uImgInv, uRim, uTextH, uPoster;
/* flat sheet: the film thins from the top and takes the type with it */
float eat(vec2 uv){ return smoothstep(0., 0.1, (1.0 - uv.y) + 0.07*(vnoise(uv*vec2(13.,9.)) - 0.5) - uAge*0.82 - 0.015); }
float baseH(float u){
  float f = uAge*0.82;
  float s = clamp((u - f)/(1.0 - f + 1e-3), 0., 1.);
  return 0.0022 + uHmax*(1.0 - 0.45*uAge)*pow(s, 1.2);
}
float lum(vec2 uv){ vec3 c = texture(uImg, uv).rgb; float l = dot(c, vec3(.2126,.7152,.0722)); return mix(l, 1.-l, uImgInv); }
float targetH(vec2 uv){
  float T = baseH(1.0 - uv.y);
  T += uImgAmt*(lum(uv) - 0.5)*0.8*(1.0 - 0.4*uAge);
  float m = texture(uMask, uv).r, g = texture(uBlur, uv).r;
  T += uRim*0.2*g*(1.0 - m);
  T = max(T, 0.0022);
  return mix(T, max(uTextH*mix(1., eat(uv), uPoster), 0.0022), m);
}
`;
const FS = {
advV: HEAD + `uniform sampler2D uV; uniform float uDt; uniform vec2 uAsp;
void main(){ vec2 v = texture(uV,vUv).xy; o = vec4(texture(uV, vUv - uDt*v/uAsp).xy, 0., 1.); }`,

force: HEAD + NOISE + TARGET + `uniform sampler2D uV, uH, uBlurPrev; uniform float uDt, uTime, uBuoy, uAir, uPush; uniform vec2 uAsp, uTexel, uPtr, uPtrV;
float psi0(vec2 p){ return vnoise(p*1.6 + vec2(0., uTime*0.11)) + 0.55*vnoise(p*3.7 - vec2(uTime*0.17, 3.)) + 0.25*vnoise(p*8.1 + vec2(5., -uTime*0.23)); }
float psi(vec2 p){ return uPoster > 0.5 ? psi0(p) : mix(psi0(p), psi0(p - vec2(uAsp.x,0.)), clamp(p.x/uAsp.x,0.,1.)); }
void main(){
  vec2 v = texture(uV,vUv).xy; vec2 p = vUv*uAsp;
  float h = texture(uH,vUv).r;
  v.y += uDt*uBuoy*(targetH(vUv) - h);
  float e = 0.012;
  v += uDt*uAir*vec2(psi(p+vec2(0,e)) - psi(p-vec2(0,e)), -(psi(p+vec2(e,0)) - psi(p-vec2(e,0))))/(2.*e);
  vec2 ex = vec2(uTexel.x,0.), ey = vec2(0.,uTexel.y);
  float dR = texture(uBlur,vUv+ex).r - texture(uBlurPrev,vUv+ex).r, dL = texture(uBlur,vUv-ex).r - texture(uBlurPrev,vUv-ex).r;
  float dT = texture(uBlur,vUv+ey).r - texture(uBlurPrev,vUv+ey).r, dB = texture(uBlur,vUv-ey).r - texture(uBlurPrev,vUv-ey).r;
  v -= uDt*uPush*vec2(dR-dL, dT-dB)/(2.*uTexel.y);
  vec2 d = p - uPtr*uAsp; v += uPtrV*exp(-dot(d,d)/0.0045)*min(1., uDt*14.);
  v *= exp(-uDt*0.55);
  o = vec4(v,0.,1.);
}`,

curl: HEAD + `uniform sampler2D uV; uniform vec2 uTexel;
void main(){ vec2 ex=vec2(uTexel.x,0.), ey=vec2(0.,uTexel.y);
  o = vec4(0.5*((texture(uV,vUv+ex).y - texture(uV,vUv-ex).y) - (texture(uV,vUv+ey).x - texture(uV,vUv-ey).x)),0.,0.,1.); }`,

vort: HEAD + `uniform sampler2D uV, uC; uniform vec2 uTexel; uniform float uDt, uEps;
void main(){ vec2 ex=vec2(uTexel.x,0.), ey=vec2(0.,uTexel.y);
  float c = texture(uC,vUv).r;
  vec2 g = vec2(abs(texture(uC,vUv+ex).r) - abs(texture(uC,vUv-ex).r), abs(texture(uC,vUv+ey).r) - abs(texture(uC,vUv-ey).r));
  g /= (length(g) + 1e-5);
  o = vec4(texture(uV,vUv).xy + uDt*uEps*c*vec2(g.y,-g.x), 0., 1.); }`,

div: HEAD + `uniform sampler2D uV; uniform vec2 uTexel;
void main(){ vec2 ex=vec2(uTexel.x,0.), ey=vec2(0.,uTexel.y);
  o = vec4(0.5*(texture(uV,vUv+ex).x - texture(uV,vUv-ex).x + texture(uV,vUv+ey).y - texture(uV,vUv-ey).y),0.,0.,1.); }`,

jac: HEAD + `uniform sampler2D uP, uD; uniform vec2 uTexel;
void main(){ vec2 ex=vec2(uTexel.x,0.), ey=vec2(0.,uTexel.y);
  o = vec4((texture(uP,vUv+ex).r + texture(uP,vUv-ex).r + texture(uP,vUv+ey).r + texture(uP,vUv-ey).r - texture(uD,vUv).r)*0.25,0.,0.,1.); }`,

grad: HEAD + `uniform sampler2D uV, uP; uniform vec2 uTexel; uniform float uPoster;
void main(){ vec2 ex=vec2(uTexel.x,0.), ey=vec2(0.,uTexel.y);
  vec2 v = texture(uV,vUv).xy - 0.5*vec2(texture(uP,vUv+ex).r - texture(uP,vUv-ex).r, texture(uP,vUv+ey).r - texture(uP,vUv-ey).r);
  vec2 b = min(vUv, 1.-vUv)/uTexel;                    /* the film is pinned to its frame */
  v *= smoothstep(0.5, 2.0, mix(b.y, min(b.x, b.y), uPoster));   /* sheet: pinned all round; bubble: only at the poles */
  o = vec4(v,0.,1.); }`,

advH: HEAD + `uniform sampler2D uH, uV; uniform float uDt; uniform vec2 uAsp;
void main(){ o = vec4(texture(uH, vUv - uDt*texture(uV,vUv).xy/uAsp).r,0.,0.,1.); }`,

/* MacCormack correction, then thickness sources. */
comb: HEAD + NOISE + TARGET + `uniform sampler2D uH0, uHhat, uHbar, uV; uniform float uDt, uTime, uHold; uniform vec2 uAsp, uTexel;
void main(){
  vec2 v = texture(uV,vUv).xy; vec2 back = vUv - uDt*v/uAsp;
  float hat = texture(uHhat,vUv).r;
  float r = hat + 0.5*(texture(uH0,vUv).r - texture(uHbar,vUv).r);
  vec2 b0 = (floor(back/uTexel - 0.5) + 0.5)*uTexel;
  float a = texture(uH0,b0).r, b = texture(uH0,b0+vec2(uTexel.x,0.)).r, c = texture(uH0,b0+vec2(0.,uTexel.y)).r, d = texture(uH0,b0+uTexel).r;
  float h = clamp(r, min(min(a,b),min(c,d)), max(max(a,b),max(c,d)));
  float T = targetH(vUv);
  float m = texture(uMask,vUv).r, g = texture(uBlur,vUv).r;
  float k = uHold + 16.*m + 2.5*g;
  h += (T - h)*(1. - exp(-uDt*k));
  /* marginal regeneration: thin patches are born at the wet border and rise */
  float xb = min(vUv.x, 1.-vUv.x)*uAsp.x;
  float edge = mix(smoothstep(0.035,0.,vUv.y), max(smoothstep(0.03,0.,vUv.y), smoothstep(0.02,0.,xb)*smoothstep(0.75,0.25,vUv.y)), uPoster);
  float n = vnoise(vec2((vUv.x*uAsp.x + vUv.y)*17., uTime*0.42)) ;
  float thin = T*(1. - 0.8*smoothstep(0.52,0.7,n));
  h += (thin - h)*(1. - exp(-uDt*7.*edge));
  o = vec4(clamp(h,0.,1.3),0.,0.,1.);
}`,

init: HEAD + NOISE + TARGET + `uniform vec2 uAsp;
void main(){ vec2 p = vUv*uAsp; float n = vnoise(p*5.) + 0.5*vnoise(p*13.);
  o = vec4(targetH(vUv)*(0.86 + 0.2*n),0.,0.,1.); }`,

blur: HEAD + `uniform sampler2D uT; uniform vec2 uDir;
void main(){ float s = 0., w = 0.;
  for (int i=-20;i<=20;i++){ float f = float(i); float g = exp(-f*f/128.); s += g*texture(uT, vUv + uDir*f).r; w += g; }
  o = vec4(s/w,0.,0.,1.); }`,

render: HEAD + NOISE + `uniform sampler2D uH, uLut, uMask, uImg; uniform vec2 uRes, uAsp, uHoleC; uniform vec3 uInk;
uniform float uCanv, uSpin, uHoleR, uFade, uSeed, uTextH, uInkOn, uShow, uHasImg, uCut;
const float PI = 3.14159265;
float bic(vec2 uv){
  vec2 st = uv*uRes - 0.5; vec2 i = floor(st), f = st - i;
  vec2 w0 = (1.-f)*(1.-f)*(1.-f)/6., w1 = (4. - 6.*f*f + 3.*f*f*f)/6., w2 = (1. + 3.*f + 3.*f*f - 3.*f*f*f)/6., w3 = f*f*f/6.;
  vec2 g0 = w0+w1, g1 = w2+w3;
  vec2 t0 = (i - 0.5 + w1/g0)/uRes, t1 = (i + 1.5 + w3/g1)/uRes;
  return g0.y*(g0.x*texture(uH,vec2(t0.x,t0.y)).r + g1.x*texture(uH,vec2(t1.x,t0.y)).r)
       + g1.y*(g0.x*texture(uH,vec2(t0.x,t1.y)).r + g1.x*texture(uH,vec2(t1.x,t1.y)).r);
}
/* longitude wraps around the bubble, latitude runs pole to pole */
vec2 sph(vec3 n){ return vec2(fract(0.5 + (atan(n.x, n.z) + uSpin)/(2.*PI)), acos(clamp(-n.y,-1.,1.))/PI); }
/* what the bubble reflects: a studio window with mullions, a fill light, a soft dome, or your image */
vec3 env(vec3 d){
  vec3 L = normalize(vec3(-0.55,0.6,0.58)); vec3 rt = normalize(cross(vec3(0.,1.,0.), L)); vec3 up = cross(L, rt);
  float f = dot(d,L); vec2 a = vec2(dot(d,rt), dot(d,up))/max(f,1e-3);
  float win = step(0.,f)*smoothstep(0.62,0.54,abs(a.x))*smoothstep(0.82,0.74,abs(a.y));
  win *= smoothstep(0.012,0.03,abs(a.x))*smoothstep(0.012,0.03,abs(a.y - 0.12));
  float fill = smoothstep(0.84,0.97,dot(d, normalize(vec3(0.78,-0.12,0.3))))*0.4;
  float amb = 0.05 + 0.11*smoothstep(-0.35,1.,d.y);
  vec3 e = vec3(win*1.35 + fill + amb);
  vec2 iu = vec2(0.5 + atan(d.x,d.z)/(2.*PI), 0.5 + asin(clamp(d.y,-1.,1.))/PI);
  vec3 im = texture(uImg, iu).rgb; im = im*im*1.5 + 0.03;
  return mix(e, im, uShow*uHasImg);
}
vec3 film(vec3 n, float ci, out float mm){
  vec2 uv = sph(n);
  float h = bic(uv), m = texture(uMask, uv).r;
  h = mix(max(h, 0.0022), max(uTextH, 0.0022), m);
  float hr = length((uv - uHoleC)*uAsp);
  if (uHoleR > 0.) h += 0.55*exp(-pow((hr - uHoleR)/0.014, 2.))*step(uHoleR, hr);
  float alive = (uHoleR > 0. && hr < uHoleR) ? 0. : 1.;
  float ct = sqrt(1. - (1. - ci*ci)/(1.33*1.33));
  float rs = (ci - 1.33*ct)/(ci + 1.33*ct), rp = (1.33*ci - ct)/(1.33*ci + ct);
  float F = min(0.5*(rs*rs + rp*rp)/0.02006, 40.);
  float opd = 2.*1.33*h*${HN}.0*ct;
  mm = m*alive;
  return texture(uLut, vec2(clamp(opd/${OPD_MAX}.0, 0., 1.), 0.5)).rgb*F*alive;
}
void main(){
  vec2 q = (vUv - 0.5)*vec2(uCanv, 1.);
  float R = 0.41*min(uCanv, 1.);
  vec2 d = q - vec2(0., 0.03);
  vec3 c = vec3(0.); float mf = 0., mb = 0.;
  float r2 = dot(d,d);
  if (r2 < R*R){
    float z = sqrt(R*R - r2);
    vec3 N = vec3(d, z)/R, Nb = vec3(d, -z)/R, D = vec3(0.,0.,-1.);
    float ci = max(N.z, 0.02);
    vec3 ff = film(N, ci, mf), fb = film(Nb, ci, mb);       /* near wall and far wall, seen through each other */
    /* in cut-out mode a letter is a hole through the film: nothing reflects there, on either wall */
    float hn = uCut*smoothstep(0.3, 0.7, mf), hb = uCut*smoothstep(0.3, 0.7, mb);
    c = ff*env(reflect(D, N))*(1. - hn) + 0.8*fb*env(reflect(D, Nb))*(1. - hb)*(1. - hn);
    c *= uFade*smoothstep(R, R - 2.5/uRes.y, sqrt(r2));
  }
  float Y = dot(c, vec3(.2126,.7152,.0722)), mn = min(c.r,min(c.g,c.b));
  if (mn < 0.) c = Y + (c - Y)*(Y/(Y - mn));
  c = mix(vec3(Y), c, 0.88);
  c += vec3(0.0015,0.0018,0.0024) + 0.006*exp(-dot(q,q)*3.5)*vec3(0.6,0.75,0.9);
  c = 1. - exp(-1.3*max(c,0.));
  c = pow(c, vec3(1./2.2));
  c = mix(c, uInk*uFade, uInkOn*max(mf, 0.3*mb*(1. - mf)));
  float gr = hash(gl_FragCoord.xy + uSeed) - 0.5;
  c += gr*0.02*(0.2 + c);
  o = vec4(c,1.);
}`,

renderP: HEAD + NOISE + `uniform sampler2D uH, uLut, uMask, uImg; uniform vec2 uRes, uAsp, uHoleC; uniform vec3 uInk; uniform float uTilt, uHoleR, uFade, uSeed, uTextH, uInkOn, uShow, uImgInv, uImgAmt, uAge, uCut;
float eat(vec2 uv){ return smoothstep(0., 0.1, (1.0 - uv.y) + 0.07*(vnoise(uv*vec2(13.,9.)) - 0.5) - uAge*0.82 - 0.015); }
float bic(vec2 uv){
  vec2 st = uv*uRes - 0.5; vec2 i = floor(st), f = st - i;
  vec2 w0 = (1.-f)*(1.-f)*(1.-f)/6., w1 = (4. - 6.*f*f + 3.*f*f*f)/6., w2 = (1. + 3.*f + 3.*f*f - 3.*f*f*f)/6., w3 = f*f*f/6.;
  vec2 g0 = w0+w1, g1 = w2+w3;
  vec2 t0 = (i - 0.5 + w1/g0)/uRes, t1 = (i + 1.5 + w3/g1)/uRes;
  return g0.y*(g0.x*texture(uH,vec2(t0.x,t0.y)).r + g1.x*texture(uH,vec2(t1.x,t0.y)).r)
       + g1.y*(g0.x*texture(uH,vec2(t0.x,t1.y)).r + g1.x*texture(uH,vec2(t1.x,t1.y)).r);
}
void main(){
  vec2 p = (vUv - 0.5)*uAsp;
  float h = bic(vUv);
  vec2 e = 1.5/uRes;
  vec2 gh = vec2(bic(vUv+vec2(e.x,0.)) - bic(vUv-vec2(e.x,0.)), bic(vUv+vec2(0.,e.y)) - bic(vUv-vec2(0.,e.y)))/(2.*e.y);
  float m = texture(uMask, vUv).r;
  float il = dot(texture(uImg, vUv).rgb, vec3(.2126,.7152,.0722)); il = mix(il, 1.-il, uImgInv);
  h += uShow*uImgAmt*0.16*(il - 0.5);                 /* crisp relief the flow cannot smear */
  float ea = eat(vUv);
  h = mix(max(h, 0.0022), max(uTextH*ea, 0.0022), m);
  float hr = length((vUv - uHoleC)*uAsp);
  if (uHoleR > 0.) h += 0.55*exp(-pow((hr - uHoleR)/0.014, 2.))*step(uHoleR, hr);
  vec3 n = normalize(vec3(-gh*0.004, 1.));
  float D = 2.4;
  vec3 cam = D*vec3(0., -sin(uTilt), cos(uTilt));
  vec3 v = normalize(cam - vec3(p,0.));
  float ci = clamp(dot(n,v), 0.05, 1.);
  float si2 = 1. - ci*ci;
  float ct = sqrt(1. - si2/(1.33*1.33));
  float rs = (ci - 1.33*ct)/(ci + 1.33*ct), rp = (1.33*ci - ct)/(1.33*ci + ct);
  float F = 0.5*(rs*rs + rp*rp)/0.02006;
  float opd = 2.*1.33*h*${HN}.0*ct;
  vec3 c = texture(uLut, vec2(clamp(opd/${OPD_MAX}.0, 0., 1.), 0.5)).rgb * min(F, 4.);
  /* one large softbox reflected in the film, falling off toward the frame */
  vec3 r = reflect(-v, n);
  float box = smoothstep(1.25, 0.15, length((p + r.xy*0.9)*vec2(0.85,0.7) - vec2(0.,0.06)));
  c *= (0.4 + 0.62*box)*uFade;
  c *= mix(1., 0.1 + 1.25*il*il, uShow*(1. - m*smoothstep(0., 0.03, uTextH*ea)));        /* the film mirrors the image */
  c *= 1. - uCut*smoothstep(0.3, 0.7, m);              /* cut-out type: no film inside the letters */
  if (uHoleR > 0. && hr < uHoleR) c = vec3(0.);
  float Y = dot(c, vec3(.2126,.7152,.0722)), mn = min(c.r,min(c.g,c.b));
  if (mn < 0.) c = Y + (c - Y)*(Y/(Y - mn));
  c = mix(vec3(Y), c, 0.84);
  c = 1. - exp(-1.3*max(c,0.));
  c += 0.0012;
  c = pow(c, vec3(1./2.2));
  if (!(uHoleR > 0. && hr < uHoleR)) c = mix(c, uInk*uFade, m*uInkOn*ea);
  float gr = hash(gl_FragCoord.xy + uSeed) - 0.5;
  c += gr*0.02*(0.2 + c);
  o = vec4(c,1.);
}`
};

function compile(type, src){ const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s), src.split('\n').slice(0,6).join('\n')); return s; }
const vs = compile(gl.VERTEX_SHADER, VS);
const P = {};
for (const k in FS){
  const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FS[k]));
  gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error(k, gl.getProgramInfoLog(p));
  P[k] = {p, u:{}};
}
const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

function tex(w, h, half, data, noWrap){
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  if (half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, data ? gl.FLOAT : gl.HALF_FLOAT, data || null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data || null);
  for (const [k,v] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],[gl.TEXTURE_WRAP_S, noWrap || !isBubble() ? gl.CLAMP_TO_EDGE : gl.REPEAT],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  return t;
}
function target(w, h){ const t = tex(w, h, true), f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
  return {t, f, w, h, texel:[1/w, 1/h]}; }
function pair(w, h){ const o = {a:target(w,h), b:target(w,h), swap(){ const x = o.a; o.a = o.b; o.b = x; }}; return o; }
function free(...ts){ for (const x of ts){ if (!x) continue; for (const y of (x.a ? [x.a, x.b] : [x])){ gl.deleteTexture(y.t); gl.deleteFramebuffer(y.f); } } }
function run(name, dst, uni){
  const pr = P[name]; gl.useProgram(pr.p); let unit = 0;
  for (const k in uni){
    const loc = pr.u[k] !== undefined ? pr.u[k] : (pr.u[k] = gl.getUniformLocation(pr.p, k));
    if (loc === null) continue; const v = uni[k];
    if (v instanceof WebGLTexture){ gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, v); gl.uniform1i(loc, unit++); }
    else if (typeof v === 'number') gl.uniform1f(loc, v);
    else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
    else gl.uniform2f(loc, v[0], v[1]);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.f : null);
  gl.viewport(0, 0, dst ? dst.w : canvas.width, dst ? dst.h : canvas.height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

const lutTex = tex(LUT_N, 1, true, lut, true);
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
const imgTex = tex(2, 2, false), maskTex = tex(2, 2, false);
const textCv = document.createElement('canvas'), imgCv = document.createElement('canvas');

/* ---------- state ---------- */
const S = { ar:0.8, age:0, mode:'alive', mt:0, fade:1, hole:[0.5,0.8], holeR:-1, frozen:false, time:0, push:0,
  ptr:[0.5,0.5], ptrV:[0,0], img:null, imgKind:'none', spin:0 };
let V, Pr, Dv, Cu, H, Hhat, Hbar, Bcur, Bprev, Btmp;
const val = id => parseFloat($(id).value);

function common(){ return { uPoster:isBubble() ? 0 : 1, uImg:imgTex, uMask:maskTex, uBlur:Bcur.t, uAge:S.age, uHmax:val('hmax')/HN,
  uImgAmt:S.imgKind === 'none' ? 0 : val('amt')/100, uImgInv:$('inv').checked ? 1 : 0, uRim:val('rim')/100, uTextH:$('inkmode').value === 'film' ? val('texth')/HN : 0 }; }

function allocate(){
  free(V, Pr, Dv, Cu, H, Hhat, Hbar, Bcur, Bprev, Btmp);
  const g = GRID[MODE], vw = Math.round(g.vel * DA()), dw = Math.round(g.dye * DA()), bw = Math.round(512 * DA());
  V = pair(vw, g.vel); Pr = pair(vw, g.vel); Dv = target(vw, g.vel); Cu = target(vw, g.vel);
  H = pair(dw, g.dye); Hhat = target(dw, g.dye); Hbar = target(dw, g.dye);
  Bcur = target(bw, 512); Bprev = target(bw, 512); Btmp = target(bw, 512);
}
function clearT(t){ gl.bindFramebuffer(gl.FRAMEBUFFER, t.f); gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT); }
function newFilm(){
  S.age = 0; [V.a, V.b, Pr.a, Pr.b].forEach(clearT);
  run('init', H.a, Object.assign(common(), {uAsp:[DA(),1]}));
}

/* ---------- image ---------- */
function drawImage(){
  const h = 1024, w = Math.round(h * DA()); imgCv.width = w; imgCv.height = h;
  const x = imgCv.getContext('2d'); x.fillStyle = '#808080'; x.fillRect(0,0,w,h);
  if (S.imgKind === 'upload' && S.img){
    const s = Math.max(w / S.img.width, h / S.img.height), iw = S.img.width * s, ih = S.img.height * s;
    x.drawImage(S.img, (w - iw)/2, (h - ih)/2, iw, ih);
  } else if (S.imgKind === 'sphere'){
    x.fillStyle = '#000'; x.fillRect(0,0,w,h);
    const cx = w*0.5, cy = h*0.36, r = Math.min(w*0.4, h*0.3);
    const g = x.createRadialGradient(cx - r*0.28, cy - r*0.32, r*0.02, cx, cy, r);
    g.addColorStop(0,'#fff'); g.addColorStop(0.35,'#c9c9c9'); g.addColorStop(0.7,'#6e6e6e'); g.addColorStop(0.93,'#1c1c1c'); g.addColorStop(1,'#0a0a0a');
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fill();
    const f = x.createLinearGradient(0, cy + r*0.9, 0, h); f.addColorStop(0,'rgba(120,120,120,0)'); f.addColorStop(1,'rgba(150,150,150,.9)');
    x.fillStyle = f; x.fillRect(0, cy + r*0.9, w, h);
  }
  gl.bindTexture(gl.TEXTURE_2D, imgTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, imgCv);
}

/* ---------- type ---------- */
function fontSpec(px){ const [w, fam] = $('font').value.split('|'); return `${w} ${px}px ${fam}, "Noto Sans KR", sans-serif`; }
function drawText(pushing){
  const h = GRID[MODE].text, w = Math.round(h * DA()); textCv.width = w; textCv.height = h;
  const x = textCv.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0,0,w,h);
  const px = val('size')/100 * h, lead = px * ($('font').value.includes('Serif') ? 0.98 : 0.9);
  x.font = fontSpec(px); x.fillStyle = '#fff'; x.textBaseline = 'alphabetic';
  if ('letterSpacing' in x) x.letterSpacing = (val('track')/100 * px) + 'px';
  const margin = w * (isBubble() ? 0.33 : 0.07), maxW = w - margin*2, lines = [];   /* on the bubble, keep the type on the near side */
  for (const raw of $('text').value.split('\n')){
    let line = '';
    for (const word of raw.split(/(\s+)/)){
      if (x.measureText(line + word).width <= maxW || !line.trim()){
        if (x.measureText(line + word).width <= maxW){ line += word; continue; }
        for (const ch of word){ if (x.measureText(line + ch).width > maxW && line){ lines.push(line); line = ''; } line += ch; }
      } else { lines.push(line.trimEnd()); line = word.trim() ? word : ''; }
    }
    lines.push(line.trimEnd());
  }
  const al = $('align').value; x.textAlign = al;
  const ax = al === 'left' ? margin : al === 'right' ? w - margin : w/2;
  const block = lines.length * lead, y0 = val('ypos')/100 * h - (isBubble() ? block/2 : 0) + lead*0.82;
  lines.forEach((l, i) => x.fillText(l, ax, y0 + i*lead));
  gl.bindTexture(gl.TEXTURE_2D, maskTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, textCv);
  const t = Bprev; Bprev = Bcur; Bcur = t;
  run('blur', Btmp, {uT:maskTex, uDir:[Btmp.texel[0], 0]});
  run('blur', Bcur, {uT:Btmp.t, uDir:[0, Btmp.texel[1]]});
  if (pushing) S.push = 1;
}
let fontJob = 0;
function textChanged(pushing){
  drawText(pushing);
  const job = ++fontJob;
  if (document.fonts && document.fonts.load) document.fonts.load(fontSpec(40), $('text').value || 'A').then(() => { if (job === fontJob) drawText(false); }).catch(() => {});
}

/* ---------- simulation ---------- */
function step(dt){
  const asp = [DA(), 1], c = common();
  run('advV', V.b, {uV:V.a.t, uDt:dt, uAsp:asp}); V.swap();
  run('force', V.b, Object.assign({}, c, {uV:V.a.t, uH:H.a.t, uBlurPrev:Bprev.t, uDt:dt, uTime:S.time, uBuoy:3.4,
    uAir:val('air')/100 * 0.085, uPush:0.03 * S.push, uAsp:asp, uTexel:V.a.texel, uPtr:S.ptr, uPtrV:S.ptrV})); V.swap();
  run('curl', Cu, {uV:V.a.t, uTexel:V.a.texel});
  run('vort', V.b, {uV:V.a.t, uC:Cu.t, uTexel:V.a.texel, uDt:dt, uEps:9}); V.swap();
  run('div', Dv, {uV:V.a.t, uTexel:V.a.texel});
  for (let i = 0; i < 22; i++){ run('jac', Pr.b, {uP:Pr.a.t, uD:Dv.t, uTexel:V.a.texel}); Pr.swap(); }
  run('grad', V.b, {uV:V.a.t, uP:Pr.a.t, uTexel:V.a.texel, uPoster:isBubble() ? 0 : 1}); V.swap();
  run('advH', Hhat, {uH:H.a.t, uV:V.a.t, uDt:dt, uAsp:asp});
  run('advH', Hbar, {uH:Hhat.t, uV:V.a.t, uDt:-dt, uAsp:asp});
  run('comb', H.b, Object.assign({}, c, {uH0:H.a.t, uHhat:Hhat.t, uHbar:Hbar.t, uV:V.a.t, uDt:dt, uTime:S.time,
    uHold:val('hold'), uAsp:asp, uTexel:H.a.texel})); H.swap();
  S.time += dt; S.push = Math.max(0, S.push - dt*2.2);
  S.ptrV = [S.ptrV[0]*0.8, S.ptrV[1]*0.8];
}
function draw(){
  run(isBubble() ? 'render' : 'renderP', null, {uH:H.a.t, uLut:lutTex, uMask:maskTex, uRes:[H.a.w, H.a.h], uAsp:[DA(),1], uHoleC:S.hole, uAge:S.age, uCanv:S.ar, uSpin:S.spin, uHasImg:S.imgKind === 'upload' ? 1 : 0,
    uImg:imgTex, uImgInv:$('inv').checked ? 1 : 0, uImgAmt:S.imgKind === 'none' ? 0 : Math.max(0.35, val('amt')/100), uShow:S.imgKind === 'none' ? 0 : val('show')/100,
    uTextH:$('inkmode').value === 'film' ? val('texth')/HN : 0, uInkOn:$('inkmode').value === 'ink' ? 1 : 0, uCut:$('inkmode').value === 'hole' ? 1 : 0, uInk:inkRGB(),
    uTilt:val('tilt') * Math.PI/180, uHoleR:S.holeR, uFade:S.fade, uSeed:(S.time*60 % 97)});
}
function inkRGB(){ const h = $('ink').value; return [1,3,5].map(i => parseInt(h.slice(i, i+2), 16)/255); }
function pop(){ if (S.mode !== 'alive') return; S.mode = 'burst'; S.mt = 0;
  if (!isBubble()){ S.hole = [0.2 + Math.random()*0.6, 0.55 + Math.random()*0.4]; return; }
  S.hole = [(0.5 - S.spin/(2*Math.PI) + (Math.random() - 0.5)*0.3) % 1, 0.6 + Math.random()*0.3]; if (S.hole[0] < 0) S.hole[0] += 1; }
function life(dt){
  if (S.mode === 'alive'){
    S.fade = Math.min(1, S.fade + dt*1.6);
    S.age += dt/150 * val('drain');
    if (S.age >= 1){ S.age = 1; pop(); }
  } else if (S.mode === 'burst'){
    S.mt += dt; S.holeR = Math.pow(S.mt/0.5, 1.3) * 1.8;
    if (S.mt > 0.5){ S.mode = 'void'; S.mt = 0; S.holeR = -1; S.fade = 0; }
  } else { S.mt += dt; if (S.mt > 0.8){ newFilm(); S.mode = 'alive'; } }
}
let lastHud = '';
function hud(){
  const left = Math.max(0, Math.round((1 - S.age)*100));
  const st = S.mode !== 'alive' ? 'burst' : S.frozen ? 'frozen' : val('drain') === 0 ? 'held' : 'draining';
  const key = left + st; if (key === lastHud) return; lastHud = key;
  $('lifefill').style.width = left + '%'; $('lifepct').textContent = left + '% left'; $('lifestate').textContent = st;
}
function fit(){
  const r = canvas.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
  const w = Math.max(2, Math.round(r.width * d)), h = Math.max(2, Math.round(r.height * d));
  if (canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
}
let last = 0;
function frame(t){
  const dt = Math.min(1/30, Math.max(1/240, (t - last)/1000 || 1/60)); last = t;
  if (!exporting){
    fit();
    if (!S.frozen && isBubble()) S.spin += dt*val('tilt')*Math.PI/180;
    if (!S.frozen || S.mode !== 'alive'){ life(dt); if (S.mode === 'alive') step(dt); }
    draw(); hud();
  }
  requestAnimationFrame(frame);
}

/* ---------- controls ---------- */
const fmt = { drain:v => v == 0 ? 'off' : '×' + (+v).toFixed(2), size:v => (+v).toFixed(1) + '%', track:v => v + '%', ypos:v => v + '%', rim:v => v + '%',
  amt:v => v + '%', show:v => v + '%', ink:v => v.toUpperCase().slice(1),
  texth:v => { const k = Math.min(LUT_N - 1, Math.round(2*N_FILM*Math.max(v, 3)/OPD_MAX*(LUT_N - 1))); const t = tone([lut[k*4], lut[k*4+1], lut[k*4+2]]).map(x => Math.round(x*255)); return `<i class="sw" style="background:rgb(${t})"></i>${v}`; }, hold:v => (+v).toFixed(1) + '/s', hmax:v => v + ' nm', air:v => v + '%', tilt:v => v + (isBubble() ? '°/s' : '°') };
for (const id in fmt){ const el = $(id), out = $(id + 'O'); const up = () => out.innerHTML = fmt[id](el.value); el.addEventListener('input', up); up(); }
let prevLen = $('text').value.length;
$('text').addEventListener('input', () => {
  const n = $('text').value.length;
  if (n > prevLen && S.mode === 'alive') S.age = Math.min(1, S.age + 0.006*(n - prevLen));   /* every letter costs the film some of its life */
  prevLen = n; textChanged(true);
});
['size','track','ypos'].forEach(id => $(id).addEventListener('input', () => drawText(false)));
['font','align'].forEach(id => $(id).addEventListener('change', () => textChanged(true)));
$('inkmode').addEventListener('change', e => { const m = e.target.value; $('inkRow').hidden = m !== 'ink'; $('thRow').hidden = m !== 'film'; });
let fontN = 0;
$('fontfile').addEventListener('change', async e => {
  let lastOpt = null;
  for (const f of e.target.files || []){
    try {
      const fam = 'UserFont' + (++fontN), face = new FontFace(fam, await f.arrayBuffer());
      await face.load(); document.fonts.add(face);
      const o = document.createElement('option'); o.value = `400|"${fam}"`; o.textContent = f.name.replace(/\.[^.]+$/, '').slice(0, 28);
      $('myfonts').appendChild(o); $('myfonts').hidden = false; lastOpt = o;
    } catch (err){ note(`${f.name} could not be read as a font. Use TTF, OTF, WOFF or WOFF2.`); }
  }
  if (lastOpt){ $('font').value = lastOpt.value; note(''); textChanged(true); }
  e.target.value = '';
});
$('sample').addEventListener('change', e => { S.imgKind = e.target.value; drawImage(); });
$('file').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  const url = URL.createObjectURL(f), im = new Image();
  im.onload = () => { S.img = im; S.imgKind = 'upload'; const o = $('sample').querySelector('[value=upload]'); o.disabled = false; o.textContent = f.name.slice(0, 22); $('sample').value = 'upload'; drawImage(); note(''); };
  im.onerror = () => note('That file could not be read as an image. Try a JPG or PNG.');
  im.src = url;
});
$('freeze').addEventListener('click', e => { S.frozen = !S.frozen; e.currentTarget.setAttribute('aria-pressed', S.frozen); e.currentTarget.textContent = S.frozen ? 'Frozen' : 'Freeze'; });
$('redip').addEventListener('click', () => { if (S.mode === 'alive'){ newFilm(); S.fade = 0; } });
$('pop').addEventListener('click', pop);
$('format').addEventListener('change', e => setFormat(parseFloat(e.target.value)));
function setFormat(ar){
  S.ar = ar; document.documentElement.style.setProperty('--ar', ar);
  if (!isBubble()) rebuild();       /* the flat sheet's simulation takes the poster's proportions */
}
function note(s){ $('note').textContent = s; }

let lp = null;
canvas.addEventListener('pointermove', e => {
  const r = canvas.getBoundingClientRect(), now = performance.now();
  let u;
  if (isBubble()){
    const qx = ((e.clientX - r.left)/r.width - 0.5)*S.ar, qy = 0.5 - (e.clientY - r.top)/r.height - 0.03, R = 0.41*Math.min(S.ar, 1), r2 = qx*qx + qy*qy;
    if (r2 >= R*R){ lp = null; return; }
    const nz = Math.sqrt(R*R - r2)/R, lon = (0.5 + (Math.atan2(qx/R, nz) + S.spin)/(2*Math.PI)) % 1;
    u = [lon < 0 ? lon + 1 : lon, Math.acos(Math.max(-1, Math.min(1, -qy/R)))/Math.PI];
  } else u = [(e.clientX - r.left)/r.width, 1 - (e.clientY - r.top)/r.height];
  if (lp && Math.abs(u[0] - lp.u[0]) < 0.3 && (e.pointerType === 'mouse' || e.buttons)){
    const k = 1000 / Math.max(8, now - lp.t);
    const vx = (u[0] - lp.u[0]) * DA() * k, vy = (u[1] - lp.u[1]) * k, m = Math.hypot(vx, vy), c = m > 1.6 ? 1.6/m : 1;
    S.ptr = u; S.ptrV = [vx*c*0.55, vy*c*0.55];
  }
  lp = {u, t:now};
});
canvas.addEventListener('pointerleave', () => { lp = null; });

/* ---------- export ---------- */
let exporting = false;
const downloads = (window.claude && window.claude.use) ? window.claude.use('downloads') : null;
$('save').addEventListener('click', async () => {
  if (exporting) return; exporting = true; note('Rendering…');
  const long = Math.min(val('res'), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
  const h = S.ar <= 1 ? long : Math.round(long / S.ar), w = Math.round(h * S.ar);
  const ow = canvas.width, oh = canvas.height;
  canvas.width = w; canvas.height = h; draw();
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  canvas.width = ow; canvas.height = oh; draw(); exporting = false;
  if (!blob){ note('The export failed at this size. Try a smaller one.'); return; }
  const filename = `thin-film-${isBubble() ? 'bubble' : 'sheet'}-${w}x${h}-${Math.round((1 - S.age)*100)}pct.png`;
  try {
    if (downloads){
      const d = await downloads; if (!d){ note('Saving is not available in this view.'); return; }
      await d.save({filename, data:blob}); note(`Saved ${w} × ${h} px.`);
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); note(`Saved ${w} × ${h} px.`);
    }
  } catch (err){
    const c = err && err.code;
    note(c === 'declined' ? 'Save cancelled.' : c === 'rate_limited' ? 'A save prompt is already open.' : c === 'too_large' ? 'That size is too large to save here. Try a smaller one.' : 'Saving is not available in this view.');
  }
});

/* ---------- form switch ---------- */
const FORMS = {
  poster: { lede:'The film fills the poster and thins from the top. The type is cut out of it, so the letters are only gaps the film flows around, and whatever you wrote first is the first thing to go. Change the size, position or typeface and the gaps reshape. Drag across the film to disturb it.',
            ypos:['Top', 2, 90, 9], tilt:['View angle', 0, 60, 18], sample:'sphere' },
  bubble: { lede:'One soap bubble as a poster. The type is cut out of the film and wraps around the bubble, so the letters are only gaps the film flows around. Change the size, position or typeface and the gaps reshape. Drag across the bubble to disturb it.',
            ypos:['Position', 4, 96, 50], tilt:['Spin speed', -120, 120, 20], sample:'none' }
};
function configure(){
  const f = FORMS[MODE];
  $('lede').textContent = f.lede;
  $('formPoster').setAttribute('aria-pressed', !isBubble()); $('formBubble').setAttribute('aria-pressed', isBubble());
  for (const id of ['ypos', 'tilt']){
    const [label, min, max, v] = f[id], el = $(id);
    document.querySelector(`label[for=${id}]`).textContent = label;
    el.min = min; el.max = max; el.value = v; $(id + 'O').innerHTML = fmt[id](el.value);
  }
  if (S.imgKind !== 'upload'){ S.imgKind = f.sample; $('sample').value = f.sample; }
  for (const t of [imgTex, maskTex]){ gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, isBubble() ? gl.REPEAT : gl.CLAMP_TO_EDGE); }
}
function rebuild(){
  allocate(); drawImage(); drawText(false); drawText(false); S.push = 0; newFilm();
  for (let i = 0; i < 20; i++) step(1/45);
}
function setForm(m){
  if (m === MODE) return;
  MODE = m; try { localStorage.setItem('thinfilm-form', m); } catch (e) {}
  S.mode = 'alive'; S.holeR = -1; S.fade = 0; S.spin = 0; lp = null;
  configure(); rebuild();
}
$('formPoster').addEventListener('click', () => setForm('poster'));
$('formBubble').addEventListener('click', () => setForm('bubble'));

/* ---------- start ---------- */
document.documentElement.style.setProperty('--ar', S.ar);
configure();
allocate(); drawImage(); drawText(false); drawText(false); newFilm();
for (let i = 0; i < 50; i++) step(1/45);
fit(); draw(); hud();
textChanged(false);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => drawText(false));
if (matchMedia('(prefers-reduced-motion: reduce)').matches) $('freeze').click();
requestAnimationFrame(frame);
})();
