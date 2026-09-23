/*! Tiny Space Program v0.1.0 — built 2026-09-23T02:47:54Z with tools/build.mjs. Includes three.js r170 (MIT). */
import{a as le,b as vt,e as po,f as Kt,i as ce}from"./chunk-ZVMQQ2A2.js";import{c as fo}from"./chunk-YJFWBNIN.js";import{a as ht,b as He}from"./chunk-CAMR4LDS.js";import{$ as ke,A as Ye,B as Ze,F as se,Ga as ro,H as Je,Ha as lo,I as to,Ja as jt,K as Ae,M as wt,N as g,Na as co,P as zt,Pa as uo,Qa as ho,R as ie,Sa as mo,U as Y,W as eo,X as at,Z as Dt,_ as nt,ba as it,c as _t,d as Oe,da as ae,ea as ne,g as Ct,ga as oo,h as Be,ha as so,i as Xe,j as $e,ja as io,k as Se,ka as mt,l as je,n as oe,na as re,qa as ao,sa as no,v as Ke,w as _e,wa as Ce,x as Qe,z as Ht}from"./chunk-7PGCYISS.js";var qo=101.325;function Pt(i){let t=i.atmosphere;if(!t)return null;let e=i.radius,o=t.pressureASL/qo,s=t.rayleigh.map(R=>Math.pow(Math.max(R,.02),1.8)),n=.3*Math.pow(o,.3),a=s.map(R=>R*n),l=.036*(t.hazeDensity??1)*Math.pow(o,.25),c=t.scaleHeight,u=t.scaleHeight*.22,d=(a[0]+a[1]+a[2])/3,r=i.terrain?.style==="earthlike"?0:i.id==="rusta"?.15:.9,h=i.terrain?.style==="earthlike"?[.021,.055,.0025]:[0,0,0],f=a.map((R,D)=>R+(d-R)*r+h[D]),m=Math.max(...t.rayleigh),v=i.terrain?.style==="desert"?.85:i.terrain?.style==="earthlike"?0:.35,y=t.rayleigh.map(R=>1+(R/m-1)*v),E=i.terrain?.style==="earthlike"?{alt:4200,cover:-.02,color:[1,1,1],scale:1}:null;return{R:e,top:(e+t.height)/e,height:t.height,clouds:E,tauR:a,tauRExt:f,tauM:l,XR:e/c,XM:e/u,HR:c,HM:u,haze:y,mieG:.78-.08*Math.min(1,Math.abs((t.hazeDensity??1)-1)),sunset:t.sunset.slice(),rayleigh:t.rayleigh.slice(),shadowSoft:c/e*.35}}function xo(i){let t=Pt(i);return{uBodyCenter:{value:new g},uInvR:{value:1/i.radius},uAtmoTop:{value:t?t.top:1},uTauR:{value:new g(...t?t.tauR:[0,0,0])},uTauRExt:{value:new g(...t?t.tauRExt:[0,0,0])},uTauM:{value:t?t.tauM:0},uXR:{value:t?t.XR:1},uXM:{value:t?t.XM:1},uMieG:{value:t?t.mieG:.76},uSunset:{value:new g(...t?t.sunset:[1,1,1])},uHaze:{value:new g(...t?t.haze:[1,1,1])},uShadowSoft:{value:t?t.shadowSoft:.002},uSunDirW:{value:new g(1,0,0)},uSunRadiance:{value:new g(20,20,20)},uCloudR:{value:t&&t.clouds?1+t.clouds.alt/i.radius:1},uCloudCover:{value:t&&t.clouds?t.clouds.cover:0},uCloudTime:{value:0},uBodyRotInv:{value:new to},uOcc0:{value:new Ae(0,0,0,0)},uOcc1:{value:new Ae(0,0,0,0)},uSunAngR:{value:.01},uSkyLut:{value:null},uAmbScale:{value:1}}}var me=9,Wo=.03,gt=`
uniform vec3 uBodyCenter;
uniform float uInvR;
uniform float uAtmoTop;
uniform vec3 uTauR;
uniform vec3 uTauRExt;
uniform float uTauM;
uniform float uXR;
uniform float uXM;
uniform float uMieG;
uniform vec3 uSunset;
uniform vec3 uHaze;
uniform float uShadowSoft;
uniform vec3 uSunDirW;
uniform vec3 uSunRadiance;
uniform vec4 uOcc0;
uniform vec4 uOcc1;
uniform float uSunAngR;
#define ATMO_MS 0.03

// Visible fraction of the sun's disc from p (planet radii, body-centred) past one occluding sphere (soft penumbra,
// annular eclipses keep 1 − (occluder/sun)² of the light).
float atmoOccluded(vec3 p, vec4 occ) {
  vec3 v = occ.xyz - p;
  float t = dot(v, uSunDirW);
  if (t <= 0.0) return 1.0;
  float d = length(v);
  float sep = asin(clamp(length(cross(v, uSunDirW)) / d, 0.0, 1.0));
  float oa = asin(clamp(occ.w / d, 0.0, 1.0));
  float s = max(uSunAngR, 1e-5);
  return max(smoothstep(oa - s, oa + s, sep), 1.0 - min(oa * oa / (s * s), 1.0));
}
// Eclipse factor (0 = total) at p from the occluders PlanetSystem selected for this body (moons, parent, siblings).
float atmoEclipse(vec3 p) {
  float e = 1.0;
  if (uOcc0.w > 0.0) e = atmoOccluded(p, uOcc0);
  if (uOcc1.w > 0.0) e *= atmoOccluded(p, uOcc1);
  return e;
}

// Ray / sphere (centred at origin). Returns (tNear, tFar); tNear > tFar when missed.
vec2 atmoRaySphere(vec3 ro, vec3 rd, float rad) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - rad * rad;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e9, -1e9);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

// Schüler's Chapman approximation. X = R/H, h = altitude/H, mu = cos(zenith). Result × tau_zenith = optical depth.
float atmoChapman(float X, float h, float mu) {
  float c = sqrt(1.5707963 * (X + h));
  if (mu >= 0.0) return c / ((c - 1.0) * mu + 1.0) * exp(-h);
  float x0 = sqrt(max(1.0 - mu * mu, 0.0)) * (X + h);
  float c0 = sqrt(1.5707963 * x0);
  return 2.0 * c0 * exp(min(X - x0, 50.0)) - c / ((c - 1.0) * (-mu) + 1.0) * exp(-h);
}

// Transmittance from a point (radius r in R units, sun zenith cosine mu) to the sun, incl. the planet's shadow.
vec3 atmoSunTransmittance(float r, float mu) {
  float alt = max(r - 1.0, 0.0);
  float chR = atmoChapman(uXR, alt * uXR, mu);
  float chM = atmoChapman(uXM, alt * uXM, mu);
  vec3 t = exp(-(uTauRExt * chR + uTauM * 1.11 * chM));
  float tangentAlt = mu >= 0.0 ? 1.0 : r * sqrt(max(1.0 - mu * mu, 0.0)) - 1.0;
  return t * smoothstep(-uShadowSoft, uShadowSoft * 1.5, tangentAlt);
}

float atmoPhaseR(float c) { return 0.0596831 * (1.0 + c * c); }
float atmoPhaseM(float c, float g) {
  float g2 = g * g;
  return 0.1193662 * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// Integrate single scattering along ro + rd·t, t ∈ [t0, t1] (R units). Returns in-scattered radiance; T = transmittance.
vec3 atmoScatter(vec3 ro, vec3 rd, float t0, float t1, int steps, out vec3 T) {
  float len = max(t1 - t0, 0.0);
  // sample placement: denser where the air is denser (towards whichever end of the segment is lower)
  float a0 = length(ro + rd * t0) - 1.0, a1 = length(ro + rd * t1) - 1.0;
  float kw = clamp((a0 - a1) * uXR * 0.5, -1.0, 1.0);
  float invN = 1.0 / float(steps);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0), sumMS = vec3(0.0);
  float odR = 0.0, odM = 0.0;
  vec3 L = uSunDirW;
  for (int i = 0; i < 32; i++) {
    if (i >= steps) break;
    float u = (float(i) + 0.5) * invN;
    float f = kw > 0.0 ? mix(u, 1.0 - (1.0 - u) * (1.0 - u), kw) : mix(u, u * u, -kw);
    float fp = kw > 0.0 ? mix(1.0, 2.0 * (1.0 - u), kw) : mix(1.0, 2.0 * u, -kw);
    float t = t0 + len * f;
    float ds = len * fp * invN;
    vec3 p = ro + rd * t;
    float r = length(p);
    float alt = max(r - 1.0, 0.0);
    float dR = exp(-alt * uXR) * ds;
    float dM = exp(-alt * uXM) * ds;
    float hR = odR + dR * 0.5, hM = odM + dM * 0.5;
    float mu = dot(p, L) / r;
    vec3 tView = exp(-(uTauRExt * (uXR * hR) + uTauM * 1.11 * (uXM * hM)));
    vec3 sunT = atmoSunTransmittance(r, mu);
    if (uOcc0.w > 0.0) sunT *= atmoEclipse(p);     // moon shadows darken the air too
    vec3 att = tView * sunT;
    // artistic sunset tint on light scattered while the sun is low
    float low = 1.0 - smoothstep(-0.08, 0.3, mu);
    vec3 tint = mix(vec3(1.0), uSunset, low * 0.55);
    att *= tint;
    sumR += dR * att;
    sumM += dM * att;
    // cheap isotropic multiple-scattering term (softer, less reddened light that also reaches the twilight zone)
    sumMS += (uTauR * (uXR * dR) + uHaze * (uTauM * uXM * dM)) * tView * sqrt(sunT) * tint * smoothstep(-0.2, 0.25, mu);
    odR += dR; odM += dM;
  }
  T = exp(-(uTauRExt * (uXR * odR) + uTauM * 1.11 * (uXM * odM)));
  float cosT = dot(rd, L);
  return uSunRadiance * (sumR * uTauR * uXR * atmoPhaseR(cosT) + sumM * (uTauM * uXM * atmoPhaseM(cosT, uMieG)) * uHaze
                         + sumMS * ATMO_MS);
}

// Aerial perspective between a camera and a world-space point (both scene space). Outputs in-scatter, transmittance.
void atmoAerial(vec3 camW, vec3 pointW, int steps, out vec3 inscatter, out vec3 transmit) {
  vec3 ro = (camW - uBodyCenter) * uInvR;
  vec3 pr = (pointW - uBodyCenter) * uInvR;
  vec3 d = pr - ro;
  float len = length(d);
  inscatter = vec3(0.0); transmit = vec3(1.0);
  if (len < 1e-9) return;
  vec3 rd = d / len;
  vec2 ta = atmoRaySphere(ro, rd, uAtmoTop);
  float t0 = max(ta.x, 0.0), t1 = min(ta.y, len);
  if (ta.x > ta.y || t1 <= t0) return;
  inscatter = atmoScatter(ro, rd, t0, t1, steps, transmit);
}
`,Yt=`
uniform float uCloudR;
uniform float uCloudCover;
uniform float uCloudTime;
uniform mat3 uBodyRotInv;
vec4 cldPermute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
vec4 cldTaylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float cldNoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = cldPermute(cldPermute(cldPermute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0 / 7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = cldTaylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
// coverage 0..1 for a body-fixed direction. foot = metres per pixel: octaves smaller than ~3 px fade out (no aliasing),
// and far away the edges soften. maxOct caps the cost.
float cloudCoverageFoot(vec3 dir, float foot, int maxOct) {
  float c = cos(uCloudTime), s = sin(uCloudTime);
  vec3 p = vec3(c * dir.x + s * dir.z, dir.y, -s * dir.x + c * dir.z);
  // large weather systems: gently warped low octaves (swirls), then puffy un-warped billows for cumulus texture
  vec3 q = p * 2.2;
  vec3 w = vec3(cldNoise(q + vec3(1.7, 0.0, 3.1)), cldNoise(q + vec3(9.2, 4.4, 0.0)), cldNoise(q + vec3(0.0, 7.7, 5.3)));
  vec3 pw = p * 6.0 + w * 0.3;
  vec3 pu = p * 6.0;
  float featM = 1.0 / (uInvR * 6.0);         // metres per noise unit at frequency 1
  // the second base octave also fades once it would be smaller than ~3 px (seen from another moon it aliased into
  // blocky pixel-sized clouds)
  float w1 = clamp((featM / 2.07 / max(foot, 1e-3) - 3.0) * 0.5, 0.0, 1.0);
  float n = 0.5 * cldNoise(pw) + 0.26 * w1 * cldNoise(pw * 2.07 + 3.1);
  float a = 0.14, f = 4.3;
  for (int i = 2; i < 8; i++) {
    if (i >= maxOct) break;
    float w = clamp((featM / f / max(foot, 1e-3) - 3.0) * 0.5, 0.0, 1.0);
    if (w <= 0.0) break;
    n += a * w * (0.55 - 2.0 * abs(cldNoise(pu * f + float(i) * 1.7)));
    f *= 2.11; a *= 0.55;
  }
  // far away the coverage threshold widens with the pixel footprint (a pixel then averages many cloud cells)
  float soft = smoothstep(1500.0, 20000.0, foot) + smoothstep(0.04, 0.3, foot / featM) * 1.5;
  float lat = abs(dir.y);
  float band = 0.14 * exp(-lat * lat / 0.012) - 0.16 * exp(-(lat - 0.42) * (lat - 0.42) / 0.014) + 0.1 * exp(-(lat - 0.78) * (lat - 0.78) / 0.02);
  return smoothstep(0.1 - uCloudCover - soft * 0.08, 0.46 - uCloudCover + soft * 0.12, n + band);
}
float cloudCoverage(vec3 dir, int octaves) { return cloudCoverageFoot(dir, 1.0, octaves); }
`;function vo(i,t,e){let o=Math.sqrt(1.5707963*(i+t));if(e>=0)return o/((o-1)*e+1)*Math.exp(-t);let s=Math.sqrt(Math.max(1-e*e,0))*(i+t);return 2*Math.sqrt(1.5707963*s)*Math.exp(Math.min(i-s,50))-o/((o-1)*-e+1)*Math.exp(-t)}function fe(i,t,e,o=[0,0,0]){if(!i)return o[0]=o[1]=o[2]=1,o;let s=Math.max(t-1,0),n=vo(i.XR,s*i.XR,e),a=vo(i.XM,s*i.XM,e),c=((e>=0?1:t*Math.sqrt(Math.max(1-e*e,0))-1)+i.shadowSoft)/(i.shadowSoft*2.5);c=c<0?0:c>1?1:c;let u=c*c*(3-2*c);for(let d=0;d<3;d++)o[d]=Math.exp(-(i.tauRExt[d]*n+i.tauM*1.11*a))*u;return o}var ze=[0,0,0];function De(i,t,e,o,s,n,a=[0,0,0]){if(a[0]=a[1]=a[2]=0,!i)return a;let l=Math.sqrt(Math.max(1-e*e,0)),c=l,u=e,d=0,r=Math.sqrt(Math.max(1-o*o,0)),h=l*r>1e-6?(s-e*o)/(l*r):1;h=Math.max(-1,Math.min(1,h));let f=r*h,m=o,v=r*Math.sqrt(Math.max(1-h*h,0)),y=t*u,E=t*t-i.top*i.top,R=y*y-E;if(R<0)return a;let D=Math.sqrt(R),S=Math.max(-y-D,0),L=-y+D;if(L<=0)return a;let G=t*t-1,C=y*y-G;if(C>0){let H=-y-Math.sqrt(C);H>0&&(L=Math.min(L,H))}let W=10,U=(L-S)/W,_=0,V=0,O=0,j=0,X=0,N=0,A=0,P=0,B=[0,0,0];for(let H=0;H<W;H++){let I=S+(H+.5)*U,F=c*I,J=t+u*I,qt=d*I,kt=Math.hypot(F,J,qt),w=Math.max(kt-1,0),b=Math.exp(-w*i.XR)*U,x=Math.exp(-w*i.XM)*U,q=_+b*.5,K=V+x*.5,tt=(F*f+J*m+qt*v)/kt;fe(i,kt,tt,ze);let et=1-go(-.08,.3,tt),$=go(-.2,.25,tt);for(let T=0;T<3;T++){let M=Math.exp(-(i.tauRExt[T]*i.XR*q+i.tauM*1.11*i.XM*K)),Q=1+(i.sunset[T]-1)*et*.55,ot=M*ze[T]*Q;T===0?(O+=b*ot,N+=x*ot):T===1?(j+=b*ot,A+=x*ot):(X+=b*ot,P+=x*ot),B[T]+=(i.tauR[T]*i.XR*b+i.haze[T]*i.tauM*i.XM*x)*M*Math.sqrt(ze[T])*Q*$}_+=b,V+=x}let ut=.0596831*(1+s*s),Z=i.mieG,st=Z*Z,p=.1193662*((1-st)*(1+s*s))/((2+st)*Math.pow(Math.max(1+st-2*Z*s,1e-4),1.5)),k=[O,j,X],z=[N,A,P];for(let H=0;H<3;H++)a[H]=n*(k[H]*i.tauR[H]*i.XR*ut+z[H]*i.tauM*i.XM*p*i.haze[H]+B[H]*Wo);return a}function go(i,t,e){let o=(e-i)/(t-i);return o=o<0?0:o>1?1:o,o*o*(3-2*o)}var Qt=64,Le=6,Lt=-.35,Pe=1,Zt=`
uniform sampler2D uSkyLut;
uniform float uAmbScale;
vec3 skyLut(float muS, float row) {
  float u = clamp((muS - ${Lt.toFixed(3)}) / ${(Pe-Lt).toFixed(3)}, 0.0, 1.0);
  return texture2D(uSkyLut, vec2((0.5 + u * ${(Qt-1).toFixed(1)}) / ${Qt.toFixed(1)}, (row + 0.5) / ${Le.toFixed(1)})).rgb;
}
// radiance of the sky in a direction with elevation sine el and azimuth cosine to the sun cphi
vec3 skyLutDir(float muS, float el, float cphi) {
  float w = clamp(0.5 + 0.5 * cphi, 0.0, 1.0);
  vec3 hor = mix(skyLut(muS, 2.0), skyLut(muS, 1.0), w);
  vec3 mid = mix(skyLut(muS, 4.0), skyLut(muS, 3.0), w);
  vec3 zen = skyLut(muS, 5.0);
  float e = clamp(el, 0.0, 1.0);
  return e < 0.34 ? mix(hor, mid, smoothstep(0.0, 0.34, e)) : mix(mid, zen, smoothstep(0.34, 1.0, e));
}
`;function yo(i,t=[1,1,1]){let e=Qt,o=new Float32Array(e*Le*4),s=[0,0,0],n=[0,0,0],a=(h,f,m)=>{let v=(h*e+f)*4;o[v]=m[0]*t[0],o[v+1]=m[1]*t[1],o[v+2]=m[2]*t[2],o[v+3]=1},l=(h,f,m)=>{let v=h*f+Math.sqrt(Math.max(0,1-h*h))*Math.sqrt(Math.max(0,1-f*f))*Math.cos(m);return De(i,1.00001,h,f,v,me,s)},c=(h,f,m)=>{n[0]=n[1]=n[2]=0;for(let v of m)l(h,f,v*Math.PI/180),n[0]+=s[0],n[1]+=s[1],n[2]+=s[2];return[n[0]/m.length,n[1]/m.length,n[2]/m.length]},u=6,d=[0,45,90,135,180],r=[1,2,2,2,1];for(let h=0;h<e;h++){let f=Lt+(Pe-Lt)*h/(e-1),m=[0,0,0];for(let v=0;v<u;v++){let y=(v+.5)/u;for(let E=0;E<d.length;E++){l(y,f,d[E]*Math.PI/180);let R=y*(1/u)*(2*Math.PI*r[E]/8);m[0]+=s[0]*R,m[1]+=s[1]*R,m[2]+=s[2]*R}}a(0,h,m),a(1,h,c(.03,f,[0,20,40])),a(2,h,c(.03,f,[130,155,180])),a(3,h,c(.34,f,[0,25,50])),a(4,h,c(.34,f,[130,155,180])),a(5,h,c(1,f,[0]))}return o}function pe(i,t,e,o=[0,0,0]){let s=Qt,n=(e-Lt)/(Pe-Lt)*(s-1);n=n<0?0:n>s-1?s-1:n;let a=Math.floor(n),l=Math.min(s-1,a+1),c=n-a,u=(t*s+a)*4,d=(t*s+l)*4;for(let r=0;r<3;r++)o[r]=i[u+r]+(i[d+r]-i[u+r])*c;return o}function wo(i){let t=new Uint16Array(i.length);for(let o=0;o<i.length;o++)t[o]=eo.toHalfFloat(Math.min(i[o],6e4));let e=new ao(t,Qt,Le,Ye,Ht);return e.magFilter=_e,e.minFilter=_e,e.wrapS=e.wrapT=Ke,e.generateMipmaps=!1,e.colorSpace=Ze,e.needsUpdate=!0,e}var Oo=`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`,Bo=`
#include <common>
#include <logdepthbuf_pars_fragment>
${gt}
uniform float uOpacity;
varying vec3 vWorld;
void main() {
  #include <logdepthbuf_fragment>
  vec3 ro = (cameraPosition - uBodyCenter) * uInvR;
  vec3 rd = normalize(vWorld - cameraPosition);
  vec2 ta = atmoRaySphere(ro, rd, uAtmoTop);
  if (ta.x > ta.y || ta.y <= 0.0) discard;
  float t0 = max(ta.x, 0.0);
  float t1 = ta.y;
  vec2 tp = atmoRaySphere(ro, rd, 1.0);
  if (tp.x < tp.y && tp.x > 0.0) t1 = min(t1, tp.x);
  vec3 T;
  vec3 L = atmoScatter(ro, rd, t0, t1, SKY_STEPS, T);
  // gentle dithering against banding in dark gradients
  float dn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  L = max(L + dn / 255.0 * (0.5 + L), 0.0);     // (never negative: it is added to the scene behind)
  float a = clamp(1.0 - (T.r + T.g + T.b) / 3.0, 0.0, 1.0);
  gl_FragColor = vec4(L * uOpacity, a * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`,ue=class{constructor(t,e,{quality:o="high"}={}){this.body=t,this.params=Pt(t);let s=o==="low"?8:o==="medium"?12:16,n=o==="low"?48:96;this.geometry=new jt(1,n,n>>1),this.material=new it({uniforms:{...e,uOpacity:{value:1}},vertexShader:Oo,fragmentShader:Bo,defines:{SKY_STEPS:s},side:_t,transparent:!0,depthWrite:!1,depthTest:!0,blending:Be,blendEquation:Xe,blendSrc:Se,blendDst:je,blendSrcAlpha:$e,blendDstAlpha:Se}),this.mesh=new nt(this.geometry,this.material),this.mesh.name=`atmosphere:${t.id}`;let a=t.radius+t.atmosphere.height*1.02;this.mesh.scale.setScalar(a),this.mesh.renderOrder=-50,this.mesh.frustumCulled=!0}dispose(){this.geometry.dispose(),this.material.dispose()}},Xo=`
#include <common>
#include <logdepthbuf_pars_vertex>
${gt}
varying vec3 vDir;
varying vec3 vWorld;
varying vec3 vAtmoIn;
varying vec3 vAtmoT;
varying vec3 vSunT;
varying float vEcl;
void main() {
  vDir = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
  atmoAerial(cameraPosition, wp.xyz, AERIAL_STEPS, vAtmoIn, vAtmoT);
  vec3 rel = (wp.xyz - uBodyCenter) * uInvR;
  float r = length(rel);
  vEcl = atmoEclipse(rel);
  vSunT = atmoSunTransmittance(r, dot(rel / r, uSunDirW)) * vEcl;
}
`,$o=`
#include <common>
#include <logdepthbuf_pars_fragment>
${gt}
${Yt}
${Zt}
uniform vec3 uSunColor;
uniform vec3 uAmbDay;
uniform vec3 uAmbNight;
uniform vec3 uCloudColor;
uniform float uPixelAngle;
uniform float uOpacity;
varying vec3 vDir;
varying vec3 vWorld;
varying vec3 vAtmoIn;
varying vec3 vAtmoT;
varying vec3 vSunT;
varying float vEcl;
void main() {
  #include <logdepthbuf_fragment>
  vec3 dir = normalize(vDir);
  vec3 V = vWorld - cameraPosition;
  float dist = length(V);
  V /= dist;
  float foot = dist * uPixelAngle / max(abs(dot(V, normalize(vWorld - uBodyCenter))), 0.2);
  float cov = cloudCoverageFoot(dir, foot, CLOUD_OCT_MAX);
  // soft fade when flying through the deck, so the layer never pops
  float alpha = cov * smoothstep(60.0, 900.0, dist) * uOpacity;
  if (alpha < 0.004) discard;
  vec3 N = normalize(vWorld - uBodyCenter);
  vec3 L = uSunDirW;
  float sunUp = dot(N, L);
  float camR = length(cameraPosition - uBodyCenter) * uInvR;
  bool below = camR < uCloudR;
  // thicker cloud → brighter tops, darker bellies; bright silver lining when looking towards the sun
  float lit = below ? mix(0.95, 0.38, cov) : mix(0.8, 1.05, cov);
  float silver = pow(max(dot(V, L), 0.0), 12.0) * (1.0 - cov * 0.7) * 2.2;
  float dayF = smoothstep(-0.12, 0.12, sunUp);
  vec3 sun = uSunColor * vSunT * (0.25 + 0.75 * max(sunUp, 0.0)) * dayF * (lit + silver);
  // sky light for the local sun elevation (same curve as the terrain's ambient)
  float dusk = smoothstep(-0.25, 0.0, sunUp) * (1.0 - smoothstep(0.05, 0.35, sunUp));
  vec3 skyE = min(skyLut(sunUp, 0.0) * (uAmbScale * (1.0 + 1.6 * dusk)), uAmbDay) * vEcl;
  vec3 amb = skyE * (below ? 0.45 : 0.2) + uAmbNight * 0.2;
  vec3 col = uCloudColor * (sun * 0.36 + amb);
  col = col * vAtmoT + vAtmoIn;
  gl_FragColor = vec4(col * alpha, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`,he=class{constructor(t,e,{quality:o="high"}={}){let s=Pt(t);this.body=t,this.params=s;let n=o==="low"?96:o==="medium"?144:192;this.geometry=new jt(1,n,n>>1),this.material=new it({uniforms:{...e,uSunColor:{value:new g(3,3,3)},uAmbDay:{value:new g(.3,.4,.6)},uAmbNight:{value:new g(.02,.02,.03)},uCloudColor:{value:new g(...s.clouds.color||[1,1,1])},uPixelAngle:{value:.001},uOpacity:{value:1}},vertexShader:Xo,fragmentShader:$o,defines:{AERIAL_STEPS:o==="low"?3:5,CLOUD_OCT_MAX:o==="low"?5:o==="medium"?6:8},side:Oe,transparent:!0,premultipliedAlpha:!0,depthWrite:!1,depthTest:!0}),this.mesh=new nt(this.geometry,this.material),this.mesh.name=`clouds:${t.id}`,this.mesh.scale.setScalar(t.radius+s.clouds.alt),this.mesh.renderOrder=-45}dispose(){this.geometry.dispose(),this.material.dispose()}};var jo=`
#include <common>
#include <logdepthbuf_pars_vertex>
${gt}
#ifdef HAS_CLOUDS
${Yt}
#endif
attribute float aDepth;
attribute vec3 aDetail;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vDetail;
varying float vDepth;
varying vec3 vAtmoIn;
varying vec3 vAtmoT;
varying vec3 vSunT;
varying float vEcl;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vDetail = aDetail;
  vDepth = aDepth;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
  vec3 rel = (wp.xyz - uBodyCenter) * uInvR;
  vEcl = atmoEclipse(rel);
#ifdef HAS_ATMO
  atmoAerial(cameraPosition, wp.xyz, AERIAL_STEPS, vAtmoIn, vAtmoT);
  float r = length(rel);
  float sunUp = dot(rel / r, uSunDirW);
  vSunT = atmoSunTransmittance(r, sunUp) * vEcl;
  #ifdef HAS_CLOUDS
  {
    vec3 up = rel / r;
    vec3 dF = uBodyRotInv * up, sF = uBodyRotInv * uSunDirW;
    float t = max(uCloudR - r, 0.0) / max(sunUp, 0.1);
    float cov = cloudCoverage(normalize(dF + sF * t), 4);
    vSunT *= 1.0 - 0.62 * cov * smoothstep(0.0, 0.08, sunUp);
  }
  #endif
#else
  vAtmoIn = vec3(0.0); vAtmoT = vec3(1.0); vSunT = vec3(vEcl);
#endif
}
`,Eo=0,Ko=(()=>{let i=le(1234567),t=[],e=18,o=0;for(let s=0;s<e;s++){let n=70*Math.pow(.79,s),a=i()*2-1,l=i()*2-1,c=i()*2-1;a+=.8;let u=Math.hypot(a,l,c)||1,d=1024/n,r=[Math.round(a/u*d),Math.round(l/u*d),Math.round(c/u*d)];!r[0]&&!r[1]&&!r[2]&&(r[0]=1);let h=.075*Math.pow(.93,s)*(.7+.6*i());o+=h,t.push(`  tspWave(vec3(${r[0].toFixed(1)}, ${r[1].toFixed(1)}, ${r[2].toFixed(1)}), ${h.toFixed(4)}, p, t + ${(i()*100).toFixed(2)}, foot, g, lost);`)}return Eo=o,t.join(`
`)})(),Qo=`
#include <common>
#include <logdepthbuf_pars_fragment>
${gt}
${Zt}
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSkyDay;          // gains on the sky light (zenith / horizon); 1 = the sky table as is (debug & tuning knobs)
uniform vec3 uSkyHorizonDay;
uniform vec3 uSunColor;
uniform vec3 uAmbNight;
uniform float uPixelAngle;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vDetail;
varying float vDepth;
varying vec3 vAtmoIn;
varying vec3 vAtmoT;
varying vec3 vSunT;
varying float vEcl;

const float TAU_P = 6.28318530718 / 1024.0;
// One analytic wave on an integer lattice k-vector (so it tiles with the 1024 m detail period). Each wave fades out
// before it would alias: w → 0 when a pixel covers more than ~1/3 of its wavelength (anisotropic footprint).
void tspWave(vec3 K, float A, vec3 p, float t, float foot, inout vec3 g, inout float lost) {
  vec3 k = K * TAU_P;
  float kl = length(k);
  float lambda = 6.28318530718 / kl;
  float w = 1.0 - smoothstep(lambda * 0.07, lambda * 0.3, foot);
  float ph = dot(k, p) - sqrt(9.81 * kl) * t;
  g += k * (cos(ph) * A * w / kl);
  lost += A * (1.0 - w);
}
// returns the wave-slope vector; 'lost' = amplitude of unresolved waves (→ rougher glint)
vec3 waveGrad(vec3 p, float t, float foot, out float lost) {
  vec3 g = vec3(0.0);
  lost = 0.0;
${Ko}
  return g;
}

float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
// smooth value noise on a lattice tiling every 'per' cells (1024 m period, seamless across chunks)
float vnoiseP(vec3 x, float per) {
  vec3 i = floor(x); vec3 f = x - i;
  vec3 u = f * f * (3.0 - 2.0 * f);
  vec3 a = mod(i, per), b = mod(i + 1.0, per);
  return mix(mix(mix(hash13(a), hash13(vec3(b.x, a.y, a.z)), u.x), mix(hash13(vec3(a.x, b.y, a.z)), hash13(vec3(b.x, b.y, a.z)), u.x), u.y),
             mix(mix(hash13(vec3(a.x, a.y, b.z)), hash13(vec3(b.x, a.y, b.z)), u.x), mix(hash13(vec3(a.x, b.y, b.z)), hash13(b), u.x), u.y), u.z);
}

void main() {
  #include <logdepthbuf_fragment>
  if (vDepth < -0.5) discard;
  vec3 N0 = normalize(vNormalW);
  vec3 V = cameraPosition - vWorld;
  float dist = length(V);
  V /= dist;
  vec3 L = uSunDirW;
  float foot = dist * uPixelAngle;                      // metres per pixel
  float footA = foot / max(dot(N0, V), 0.06);           // stretched along the view direction at grazing angles
  float fade = 1.0 - smoothstep(0.3, 2.0, footA);
  float lost;
  vec3 g = waveGrad(vDetail, uTime, footA, lost);
  float unresolved = clamp(lost / WAVE_TOTAL, 0.0, 1.0);
  vec3 gt = g - N0 * dot(g, N0);
  vec3 N = normalize(N0 - gt);
  float NdV = max(dot(N, V), 0.0);

  // local sun elevation: sky light comes from the precomputed sky table (twilight colours, darkness at night)
  float sunUp = dot(N0, L);
  vec3 skyIrr = skyLut(sunUp, 0.0) * vEcl * uSkyDay;

  // water body colour
  float depth = max(vDepth, 0.0);
  vec3 water = mix(uShallow, uDeep, 1.0 - exp(-depth / 28.0));
  vec3 sunCol = uSunColor * vSunT;
  vec3 diffuse = water * (sunCol * max(sunUp, 0.0) * 0.35 + skyIrr * 0.13 + uAmbNight);

  // reflection of the actual sky above this spot: elevation of the reflected ray and its azimuth to the sun, so the
  // sunset glow is mirrored towards the sun and twilight/night seas darken with the sky.
  // unresolved waves spread the reflected directions upwards and lower the average Fresnel (distant seas stay blue)
  vec3 Rv = reflect(-V, N);
  float el = max(clamp(dot(Rv, N0), 0.0, 1.0), unresolved * 0.3);
  vec3 rt = Rv - N0 * dot(Rv, N0), st = L - N0 * sunUp;
  float cphi = dot(rt, st) * inversesqrt(max(dot(rt, rt) * dot(st, st), 1e-10));
  // (a rough, unresolved sea also mirrors part of the bright horizon band: keeps the sunset glow on the distant water)
  vec3 skyRefl = mix(skyLutDir(sunUp, el, cphi), skyLutDir(sunUp, 0.02, cphi), unresolved * 0.35);
  vec3 sky = skyRefl * vEcl * mix(uSkyHorizonDay, uSkyDay, sqrt(el)) + uAmbNight * 0.5;
  float NdVe = mix(NdV, max(NdV, 0.28), unresolved);
  float F = 0.02 + 0.98 * pow(1.0 - NdVe, 5.0);

  // sun glint (GGX), rougher with distance so the glint stays visible (and unaliased) from orbit
  float rough = mix(0.07, 0.26, unresolved) + 0.08 * smoothstep(500.0, 20000.0, foot);
  vec3 H = normalize(L + V + N0 * 1e-3);     // L = −V (sun straight behind the sea) would be NaN
  float NdH = max(dot(N, H), 0.0);
  float a2 = rough * rough * rough * rough;
  float dd = NdH * NdH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159 * dd * dd);
  float NdL = max(dot(N, L), 0.0);
  vec3 spec = sunCol * D * F * NdL * 0.25 / max(NdV * NdL, 0.05) * smoothstep(-0.02, 0.05, sunUp);
  spec = min(spec, vec3(40.0)) * 0.75;

  vec3 col = mix(diffuse, sky, F) + spec;

  // shoreline foam
  // shoreline foam: surging band + streaky bubbles (smooth periodic noise, drifting)
  vec3 fp = vDetail + vec3(0.37, 0.11, -0.29) * uTime;
  float fn = vnoiseP(fp / 2.0, 512.0) * 0.6 + vnoiseP(fp / 0.5, 2048.0) * 0.4;
  float surge = 0.45 * sin(uTime * 0.9 + dot(vDetail, vec3(0.05, 0.043, 0.037)));
  float foamBand = (1.0 - smoothstep(0.05, 1.4, depth + surge + (fn - 0.5) * 0.8)) * fade;
  float foam = foamBand * smoothstep(0.25, 0.65, fn + foamBand * 0.35);
  col = mix(col, (sunCol * max(sunUp, 0.0) * 0.8 + skyIrr * 0.17 + uAmbNight * 2.0) * 0.9, foam * 0.7);

  // soft shoreline: transparent in the shallows (sea floor visible), opaque when deep
  float alpha = smoothstep(0.0, 0.8, vDepth) * mix(0.55, 1.0, smoothstep(0.5, 18.0, depth));
  alpha = max(alpha, foam * 0.8);
  alpha = mix(alpha, 1.0, max(F, smoothstep(40.0, 400.0, foot)));

  col = col * vAtmoT + vAtmoIn;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;function bo(i,t,{quality:e="high",hasAtmo:o=!!i.atmosphere}={}){let s=i.terrain?.palette||{},n=(r,h)=>new Y(r||h).convertSRGBToLinear(),a=n(s.shallow||s.shore,"#2f8fb5"),l=n(s.ocean,"#1c4f8a"),c=r=>new g(r.r,r.g,r.b),u={AERIAL_STEPS:e==="low"?4:e==="medium"?5:6,WAVE_TOTAL:Eo.toFixed(4)};o&&(u.HAS_ATMO=1),o&&i.terrain?.style==="earthlike"&&(u.HAS_CLOUDS=1);let d=new it({uniforms:{...t,uTime:{value:0},uShallow:{value:c(a).multiplyScalar(.55)},uDeep:{value:c(l).multiplyScalar(.35)},uSkyDay:{value:new g(1,1,1)},uSkyHorizonDay:{value:new g(1,1,1)},uSunColor:{value:new g(3,3,3)},uAmbNight:{value:new g(.002,.003,.006)},uPixelAngle:{value:.001}},vertexShader:jo,fragmentShader:Qo,defines:u,transparent:!0,depthWrite:!0,depthTest:!0});return d.name=`ocean:${i.id}`,d}var Ro=new g(.42,.78,.46).normalize(),Yo=new g(.8,-.1,-.59).normalize(),Zo=`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aColor;
attribute float aSize;
uniform float uFade;
uniform float uPixelRatio;
uniform float uTime;
uniform float uTwinkle;
varying vec3 vColor;
void main() {
  vec3 dir = mat3(viewMatrix) * position;
  vec4 p = projectionMatrix * vec4(dir, 0.0);
  gl_Position = vec4(p.xy, p.w * 0.999999, p.w);
  float tw = 1.0 + uTwinkle * 0.35 * sin(uTime * (3.0 + fract(aSize * 91.7) * 5.0) + aSize * 173.0);
  vColor = aColor * uFade * tw;
  gl_PointSize = aSize * uPixelRatio;
  #include <logdepthbuf_vertex>
}
`,Jo=`
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 9.0);
  float halo = exp(-r2 * 2.5) * 0.25;
  gl_FragColor = vec4(vColor * (core + halo), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`,ts=`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 0.0);
  gl_Position = vec4(p.xy, p.w * 0.999999, p.w);
  #include <logdepthbuf_vertex>
}
`,es=`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform samplerCube uCube;
uniform float uFade;
varying vec3 vDir;
void main() {
  #include <logdepthbuf_fragment>
  vec3 c = textureCube(uCube, normalize(vDir)).rgb;
  gl_FragColor = vec4(c * uFade, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`,os=`
uniform vec3 uGal;
uniform vec3 uCenter;
varying vec3 vDir;
vec3 hash33(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash33(i).x, b = hash33(i + vec3(1,0,0)).x, c = hash33(i + vec3(0,1,0)).x, d = hash33(i + vec3(1,1,0)).x;
  float e = hash33(i + vec3(0,0,1)).x, g = hash33(i + vec3(1,0,1)).x, h = hash33(i + vec3(0,1,1)).x, k = hash33(i + vec3(1,1,1)).x;
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}
float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float b = asin(clamp(dot(d, uGal), -1.0, 1.0));           // galactic latitude
  float toC = dot(normalize(d - uGal * dot(d, uGal)), uCenter); // cos longitude from the galactic centre
  float n1 = fbm(d * 3.0);
  float n2 = fbm(d * 9.0 + 3.7);
  float n3 = fbm(d * 22.0 - 1.3);
  float width = 0.2 + 0.08 * n1;
  float band = exp(-pow(b / width, 2.0));
  float bulge = exp(-pow(b / 0.18, 2.0)) * pow(max(toC, 0.0), 6.0);
  float clumps = smoothstep(0.35, 0.8, n2) * 0.8 + 0.4;
  float stars = pow(n3, 3.0) * 1.6;
  // dust lanes darken the centre of the band
  float dust = smoothstep(0.45, 0.72, fbm(d * 6.0 + 11.0)) * exp(-pow(b / 0.07, 2.0));
  vec3 bandCol = mix(vec3(0.55, 0.62, 0.85), vec3(0.95, 0.86, 0.78), clamp(bulge * 2.0 + max(toC, 0.0) * 0.3, 0.0, 1.0));
  vec3 col = bandCol * (band * clumps * (0.6 + stars) + bulge * 1.1) * (1.0 - dust * 0.75);
  // faint colourful nebulae
  float neb1 = smoothstep(0.62, 0.85, fbm(d * 4.0 + 21.0)) * exp(-pow(b / 0.45, 2.0));
  float neb2 = smoothstep(0.64, 0.86, fbm(d * 3.5 - 17.0)) * exp(-pow(b / 0.6, 2.0));
  col += vec3(0.9, 0.3, 0.5) * neb1 * 0.5 + vec3(0.25, 0.6, 0.85) * neb2 * 0.45;
  // very faint overall sky glow
  col += vec3(0.02, 0.025, 0.04) * (0.6 + n1);
  gl_FragColor = vec4(col * 0.042, 1.0);
}
`,ss=`
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`,is=`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uSize;
varying vec2 vUv;
void main() {
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  vUv = position.xy;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`,as=`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uSize;
uniform float uDisk;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uGlare;
uniform float uTime;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vUv) * uSize / uDisk;         // in disc radii
  float a = atan(vUv.y, vUv.x);
  // disc with limb darkening
  float disc = 1.0 - smoothstep(0.97, 1.03, r);
  float mu = sqrt(max(1.0 - min(r, 1.0) * min(r, 1.0), 0.0));
  vec3 discCol = uColor * (0.55 + 0.45 * mu) * 60.0;
  // corona and wide glow
  float x = max(r - 1.0, 0.0);
  float corona = exp(-x * 2.2) * 1.4 + exp(-x * 0.45) * 0.28 + 0.9 / (1.0 + x * x * 0.6) * 0.12;
  // glare spikes: slow-rotating 6-point star + horizontal anamorphic streak
  float sp = pow(abs(cos(a * 4.0 + 0.4)), 260.0) + 0.5 * pow(abs(cos(a * 7.0 + 1.1)), 500.0);
  float spikes = sp * exp(-x * 0.42) * 0.24 * uGlare;
  float streak = exp(-abs(vUv.y * uSize / uDisk) * 7.0) * exp(-x * 0.16) * 0.18 * uGlare;
  vec3 glow = uColor * (corona + spikes + streak) * mix(vec3(1.0), vec3(1.0, 0.85, 0.65), clamp(x * 0.1, 0.0, 0.6));
  float edge = 1.0 - smoothstep(0.75, 1.0, length(vUv));   // fade out at the quad border
  vec3 col = (discCol * disc + glow * 3.0 * edge) * uIntensity;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`,ns=`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec2 aCorner;
attribute vec4 aGhost;     // t (position along sun→centre axis), size (NDC), shape, hue
uniform vec3 uSunDirW;
varying vec2 vC;
varying vec4 vG;
void main() {
  vec4 sp = projectionMatrix * vec4(mat3(viewMatrix) * uSunDirW, 0.0);
  vec2 sun = sp.xy / max(sp.w, 1e-6);
  vec2 p = sun * (1.0 - 2.0 * aGhost.x);
  float aspect = projectionMatrix[0][0] / projectionMatrix[1][1];
  vC = aCorner; vG = aGhost;
  gl_Position = vec4(p + aCorner * aGhost.y * vec2(aspect, 1.0), 0.0, 1.0);
  #include <logdepthbuf_vertex>
}
`,rs=`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uFlare;
uniform vec3 uTint;
varying vec2 vC;
varying vec4 vG;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vC);
  if (r > 1.0) discard;
  float shape;
  if (vG.z < 0.5) shape = smoothstep(1.0, 0.7, r) * 0.7 + smoothstep(1.0, 0.9, r) * smoothstep(0.8, 0.95, r) * 0.6; // disc + rim
  else if (vG.z < 1.5) shape = smoothstep(1.0, 0.85, r) * smoothstep(0.55, 0.8, r);  // ring
  else {
    // hexagonal aperture ghost
    vec2 q = abs(vC);
    float hex = max(q.x * 0.866 + q.y * 0.5, q.y);
    shape = smoothstep(0.95, 0.8, hex) * 0.8;
  }
  vec3 hue = 0.5 + 0.5 * cos(6.2831 * (vG.w + vec3(0.0, 0.33, 0.67)));
  vec3 col = mix(hue, uTint, 0.35) * shape * uFlare * 0.032;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`,ls=`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aColor;    // rgb, alpha
attribute float aSize;
uniform float uPixelRatio;
varying vec4 vColor;
void main() {
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 0.0);
  gl_Position = vec4(p.xy, p.w * 0.999999, p.w);
  vColor = aColor;
  gl_PointSize = aSize * uPixelRatio;
  #include <logdepthbuf_vertex>
}
`,cs=`
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec4 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0 || vColor.a <= 0.0) discard;
  float core = exp(-r2 * 6.0) + exp(-r2 * 2.0) * 0.3;
  gl_FragColor = vec4(vColor.rgb * core * vColor.a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;function us(i){let t=i();return t<.12?[.62,.74,1]:t<.35?[.82,.88,1]:t<.7?[1,.97,.92]:t<.88?[1,.86,.66]:t<.97?[1,.72,.5]:[1,.55,.42]}function hs(i,t=1337){let e=le(t),o=new Float32Array(i*3),s=new Float32Array(i*3),n=new Float32Array(i),a=Ro,l=new g(1,0,0).cross(a).normalize(),c=a.clone().cross(l).normalize(),u=new g;for(let r=0;r<i;r++){if(e()<.35){let v=e()*Math.PI*2,y=(e()+e()+e()-1.5)*.28,E=Math.cos(y);u.copy(l).multiplyScalar(Math.cos(v)*E).addScaledVector(c,Math.sin(v)*E).addScaledVector(a,Math.sin(y))}else{let v=e()*2-1,y=e()*Math.PI*2,E=Math.sqrt(1-v*v);u.set(E*Math.cos(y),v,E*Math.sin(y))}u.normalize(),o[r*3]=u.x,o[r*3+1]=u.y,o[r*3+2]=u.z;let h=e(),f=.07+.45*h*h*h+3*Math.pow(e(),28),m=us(e);s[r*3]=m[0]*f,s[r*3+1]=m[1]*f,s[r*3+2]=m[2]*f,n[r]=1.6+3.2*Math.sqrt(Math.min(f,2.5)/2.5)+e()*.5}let d=new Dt;return d.setAttribute("position",new at(o,3)),d.setAttribute("aColor",new at(s,3)),d.setAttribute("aSize",new at(n,1)),d.boundingSphere=new zt(new g,1e30),d}function ds(){let i=[[.08,.06,2,.1],[.22,.035,0,.55],[.38,.09,1,.3],[.55,.05,2,.75],[.68,.13,0,.45],[.82,.03,0,.05],[.95,.18,1,.62],[1.12,.07,2,.2]],t=i.length,e=new Float32Array(t*4*2),o=new Float32Array(t*4*4),s=new Float32Array(t*4*3),n=[],a=[[-1,-1],[1,-1],[1,1],[-1,1]];for(let c=0;c<t;c++){for(let u=0;u<4;u++){let d=c*4+u;e[d*2]=a[u][0],e[d*2+1]=a[u][1],o.set(i[c],d*4)}n.push(c*4,c*4+1,c*4+2,c*4,c*4+2,c*4+3)}let l=new Dt;return l.setAttribute("position",new at(s,3)),l.setAttribute("aCorner",new at(e,2)),l.setAttribute("aGhost",new at(o,4)),l.setIndex(n),l.boundingSphere=new zt(new g,1e30),l}var ve=class{constructor(t,{quality:e="high",bodyIds:o=[],bodyColors:s={}}={}){this.group=new mt,this.group.name="sky";let n=Math.min(t.getPixelRatio?.()||1,2);this.quality=e;let a=e==="low"?3500:e==="medium"?6e3:9e3;this.starGeo=hs(a),this.starMat=new it({uniforms:{uFade:{value:1},uPixelRatio:{value:n},uTime:{value:0},uTwinkle:{value:0}},vertexShader:Zo,fragmentShader:Jo,depthTest:!1,depthWrite:!1,blending:Ct,transparent:!1}),this.stars=new Ce(this.starGeo,this.starMat),this.stars.frustumCulled=!1,this.stars.renderOrder=-1e3,this.stars.name="stars",this.group.add(this.stars),this.cubeRT=this._bakeMilkyWay(t,e==="low"?256:e==="medium"?384:512),this.boxGeo=new ke(2,2,2),this.boxMat=new it({uniforms:{uCube:{value:this.cubeRT.texture},uFade:{value:1}},vertexShader:ts,fragmentShader:es,side:_t,depthTest:!1,depthWrite:!1,blending:Ct,transparent:!1}),this.box=new nt(this.boxGeo,this.boxMat),this.box.frustumCulled=!1,this.box.renderOrder=-1001,this.box.name="milkyway",this.group.add(this.box),this.sunGeo=new oo(2,2),this.sunMat=new it({uniforms:{uSize:{value:1},uDisk:{value:1},uColor:{value:new Y(1,.93,.8)},uIntensity:{value:1},uGlare:{value:1},uTime:{value:0}},vertexShader:is,fragmentShader:as,depthTest:!0,depthWrite:!1,transparent:!0,blending:Ct}),this.sun=new nt(this.sunGeo,this.sunMat),this.sun.frustumCulled=!1,this.sun.renderOrder=-90,this.sun.name="sun",this.group.add(this.sun),this.flareGeo=ds(),this.flareMat=new it({uniforms:{uSunDirW:{value:new g(1,0,0)},uFlare:{value:0},uTint:{value:new Y(1,.9,.75)}},vertexShader:ns,fragmentShader:rs,depthTest:!1,depthWrite:!1,transparent:!0,blending:Ct}),this.flare=new nt(this.flareGeo,this.flareMat),this.flare.frustumCulled=!1,this.flare.renderOrder=1e3,this.flare.name="lensflare",this.group.add(this.flare),this.dotIds=o.slice();let l=Math.max(1,this.dotIds.length);this.dotGeo=new Dt,this.dotPos=new Float32Array(l*3),this.dotCol=new Float32Array(l*4),this.dotSize=new Float32Array(l),this.dotGeo.setAttribute("position",new at(this.dotPos,3).setUsage(se)),this.dotGeo.setAttribute("aColor",new at(this.dotCol,4).setUsage(se)),this.dotGeo.setAttribute("aSize",new at(this.dotSize,1).setUsage(se)),this.dotGeo.boundingSphere=new zt(new g,1e30),this.dotMat=new it({uniforms:{uPixelRatio:{value:n}},vertexShader:ls,fragmentShader:cs,depthTest:!1,depthWrite:!1,blending:Ct,transparent:!1}),this.dots=new Ce(this.dotGeo,this.dotMat),this.dots.frustumCulled=!1,this.dots.renderOrder=-999,this.dots.name="planetDots",this.group.add(this.dots),this.bodyColors=s}_bakeMilkyWay(t,e){let o=new ne(e,{type:Ht,generateMipmaps:!0,minFilter:Qe}),s=new re,n=new ke(10,10,10),a=new it({uniforms:{uGal:{value:Ro},uCenter:{value:Yo}},vertexShader:ss,fragmentShader:os,side:_t,depthWrite:!1,depthTest:!1}),l=new nt(n,a);s.add(l);let c=new ae(.1,100,o),u=t.toneMapping;t.toneMapping=oe;try{c.update(t,s)}finally{t.toneMapping=u}return n.dispose(),a.dispose(),o}setDot(t,e,o,s,n,a,l){this.dotPos[t*3]=e.x,this.dotPos[t*3+1]=e.y,this.dotPos[t*3+2]=e.z,this.dotCol[t*4]=o,this.dotCol[t*4+1]=s,this.dotCol[t*4+2]=n,this.dotCol[t*4+3]=a,this.dotSize[t]=l}commitDots(){this.dotGeo.attributes.position.needsUpdate=!0,this.dotGeo.attributes.aColor.needsUpdate=!0,this.dotGeo.attributes.aSize.needsUpdate=!0}dispose(){this.starGeo.dispose(),this.starMat.dispose(),this.boxGeo.dispose(),this.boxMat.dispose(),this.cubeRT.dispose(),this.sunGeo.dispose(),this.sunMat.dispose(),this.flareGeo.dispose(),this.flareMat.dispose(),this.dotGeo.dispose(),this.dotMat.dispose()}};function ms(){return new URL("./terrainWorker-339f2310.js",import.meta.url).href}function Mo(i){if(typeof Worker>"u")throw new Error("Web Workers unavailable");return new Worker(ms(),Object.assign({},i,{type:"classic"}))}var Fe=[{n:[1,0,0],u:[0,0,-1],v:[0,1,0]},{n:[-1,0,0],u:[0,0,1],v:[0,1,0]},{n:[0,1,0],u:[1,0,0],v:[0,0,-1]},{n:[0,-1,0],u:[1,0,0],v:[0,0,1]},{n:[0,0,1],u:[1,0,0],v:[0,1,0]},{n:[0,0,-1],u:[-1,0,0],v:[0,1,0]}],To=Math.PI/4;function ge(i,t,e,o,s=0){let n=Fe[i],a=Math.tan(t*To),l=Math.tan(e*To),c=n.n[0]+a*n.u[0]+l*n.v[0],u=n.n[1]+a*n.u[1]+l*n.v[1],d=n.n[2]+a*n.u[2]+l*n.v[2],r=1/Math.sqrt(c*c+u*u+d*d);return o[s]=c*r,o[s+1]=u*r,o[s+2]=d*r,o}function Ao(i){return i*i+4*(i-1)}function ko(i){let t=(i-1)*(i-1),e=4*(i-1),o=new Uint16Array((t+e)*6),s=0;for(let c=0;c<i-1;c++)for(let u=0;u<i-1;u++){let d=c*i+u,r=d+1,h=d+i,f=h+1;(u+c&1)===0?(o[s++]=d,o[s++]=r,o[s++]=f,o[s++]=d,o[s++]=f,o[s++]=h):(o[s++]=d,o[s++]=r,o[s++]=h,o[s++]=r,o[s++]=f,o[s++]=h)}let n=Co(i),a=n.length,l=i*i;for(let c=0;c<a;c++){let u=n[c],d=n[(c+1)%a],r=l+c,h=l+(c+1)%a;o[s++]=u,o[s++]=r,o[s++]=d,o[s++]=d,o[s++]=r,o[s++]=h}return o}var So=new Map;function Co(i){let t=So.get(i);if(t)return t;t=[];for(let e=0;e<i-1;e++)t.push(e);for(let e=0;e<i-1;e++)t.push(e*i+(i-1));for(let e=i-1;e>0;e--)t.push((i-1)*i+e);for(let e=i-1;e>0;e--)t.push(e*i);return t=Int32Array.from(t),So.set(i,t),t}function Jt(i,t){return i*(Math.PI/2)/(1<<t)}var xt=1024,Et={height:0,color:[0,0,0],biome:"",water:!1,glow:0,gloss:0,fa:0,fb:0,hot:0},qs=new Float64Array(3);function ps(i,t,e){let o=(e-i)/(t-i);return o=o<0?0:o>1?1:o,o*o*(3-2*o)}function Ve(i){let t=Kt(i.bodyId),e=t._spacing;t._spacing=Jt(t.R,i.level)/(i.N-1);try{return vs(i,t)}finally{t._spacing=e}}function vs(i,t){let e=i.N,o=e+2,s=i.face,n=i.level,a=t.R,l=2/(1<<n),c=-1+i.ix*l,u=-1+i.iy*l,d=l/(e-1),r=Ao(e),h=new Float64Array(o*o*3),f=new Float64Array(o*o),m=new Float32Array(r*3),v=!!t.fissures,y=v?3:2,E=new Float32Array(r*y),R=1/0,D=-1/0;for(let w=0;w<o;w++){let b=u+(w-1)*d;for(let x=0;x<o;x++){let q=c+(x-1)*d,K=w*o+x;ge(s,q,b,h,K*3);let tt=h[K*3],et=h[K*3+1],$=h[K*3+2];if(x===0||w===0||x===o-1||w===o-1)f[K]=t.height(tt,et,$);else{t.sample(tt,et,$,Et);let T=Et.height;f[K]=T,T<R&&(R=T),T>D&&(D=T);let M=(w-1)*e+(x-1),Q=Et.color;m[M*3]=Q[0],m[M*3+1]=Q[1],m[M*3+2]=Q[2],v?(E[M*3]=Et.fa,E[M*3+1]=Et.fb,E[M*3+2]=Et.hot):(E[M*2]=Et.glow,E[M*2+1]=Et.gloss)}}}let S=e-1>>1,L=(S+1)*o+(S+1),G=a+f[L],C=h[L*3]*G,W=h[L*3+1]*G,U=h[L*3+2]*G,_=new Float64Array(o*o*3);for(let w=0;w<o*o;w++){let b=a+f[w];_[w*3]=h[w*3]*b,_[w*3+1]=h[w*3+1]*b,_[w*3+2]=h[w*3+2]*b}let V=new Float32Array(r*3),O=new Float32Array(r*3),j=new Float32Array(r*3),X=(C%xt+xt)%xt,N=(W%xt+xt)%xt,A=(U%xt+xt)%xt,P=t.cliff,B=t.cliffSlope[0],ut=t.cliffSlope[1],Z=0;for(let w=0;w<e;w++)for(let b=0;b<e;b++){let x=w*e+b,q=(w+1)*o+(b+1),K=_[q*3]-C,tt=_[q*3+1]-W,et=_[q*3+2]-U;V[x*3]=K,V[x*3+1]=tt,V[x*3+2]=et,j[x*3]=X+K,j[x*3+1]=N+tt,j[x*3+2]=A+et;let $=K*K+tt*tt+et*et;$>Z&&(Z=$);let T=q-1,M=q+1,Q=q-o,ot=q+o,yt=_[M*3]-_[T*3],Wt=_[M*3+1]-_[T*3+1],Mt=_[M*3+2]-_[T*3+2],Tt=_[ot*3]-_[Q*3],St=_[ot*3+1]-_[Q*3+1],Ot=_[ot*3+2]-_[Q*3+2],Bt=Wt*Ot-Mt*St,Xt=Mt*Tt-yt*Ot,$t=yt*St-Wt*Tt,Re=1/Math.sqrt(Bt*Bt+Xt*Xt+$t*$t);Bt*=Re,Xt*=Re,$t*=Re,O[x*3]=Bt,O[x*3+1]=Xt,O[x*3+2]=$t;let No=Bt*h[q*3]+Xt*h[q*3+1]+$t*h[q*3+2],Me=ps(B,ut,1-No);if(Me>0){let Te=Me*.85;m[x*3]+=(P[0]-m[x*3])*Te,m[x*3+1]+=(P[1]-m[x*3+1])*Te,m[x*3+2]+=(P[2]-m[x*3+2])*Te,v||(E[x*2+1]*=1-Me)}}let st=Jt(a,n)/(e-1),p=D-R,k=4+st*1.5+p*.06,z=Co(e),H=z.length,I=e*e;for(let w=0;w<H;w++){let b=z[w],x=I+w,q=b%e,tt=((b/e|0)+1)*o+(q+1),et=h[tt*3],$=h[tt*3+1],T=h[tt*3+2];V[x*3]=V[b*3]-et*k,V[x*3+1]=V[b*3+1]-$*k,V[x*3+2]=V[b*3+2]-T*k,j[x*3]=X+V[x*3],j[x*3+1]=N+V[x*3+1],j[x*3+2]=A+V[x*3+2],O[x*3]=O[b*3],O[x*3+1]=O[b*3+1],O[x*3+2]=O[b*3+2],m[x*3]=m[b*3],m[x*3+1]=m[b*3+1],m[x*3+2]=m[b*3+2];for(let M=0;M<y;M++)E[x*y+M]=E[b*y+M]}let F={id:i.id,bodyId:i.bodyId,face:s,level:n,ix:i.ix,iy:i.iy,N:e,center:[C,W,U],radius:Math.sqrt(Z)+k,minH:R,maxH:D,pos:V,nor:O,col:m,det:j,ext:E,ocean:null};if(t.ocean&&R<1.5){let w=new Float32Array(r*3),b=new Float32Array(r*3),x=new Float32Array(r*3),q=new Float32Array(r),K=0;for(let $=0;$<e;$++)for(let T=0;T<e;T++){let M=$*e+T,Q=($+1)*o+(T+1),ot=h[Q*3],yt=h[Q*3+1],Wt=h[Q*3+2],Mt=ot*a-C,Tt=yt*a-W,St=Wt*a-U;w[M*3]=Mt,w[M*3+1]=Tt,w[M*3+2]=St,x[M*3]=X+Mt,x[M*3+1]=N+Tt,x[M*3+2]=A+St,b[M*3]=ot,b[M*3+1]=yt,b[M*3+2]=Wt,q[M]=-f[Q];let Ot=Mt*Mt+Tt*Tt+St*St;Ot>K&&(K=Ot)}let et=1+st*st/(8*a)*3+st*.02;for(let $=0;$<H;$++){let T=z[$],M=I+$,Q=b[T*3],ot=b[T*3+1],yt=b[T*3+2];w[M*3]=w[T*3]-Q*et,w[M*3+1]=w[T*3+1]-ot*et,w[M*3+2]=w[T*3+2]-yt*et,x[M*3]=x[T*3],x[M*3+1]=x[T*3+1],x[M*3+2]=x[T*3+2],b[M*3]=Q,b[M*3+1]=ot,b[M*3+2]=yt,q[M]=q[T]}F.ocean={pos:w,nor:_o(b),det:x,depth:q,radius:Math.sqrt(K)+et}}F.nor=_o(O);let J=new Uint8Array(r*3);for(let w=0;w<r*3;w++)J[w]=Math.round(Math.sqrt(m[w]<0?0:m[w]>1?1:m[w])*255);F.col=J;let qt=v?t.fissureScale:1,kt=new Int16Array(r*y);for(let w=0;w<r*y;w++){let b=v&&w%3===2?E[w]:E[w]/qt;kt[w]=Math.round((b<-1?-1:b>1?1:b)*32767)}return F.ext=kt,F.extSize=y,F.extScale=qt,F}function _o(i){let t=new Int8Array(i.length);for(let e=0;e<i.length;e++){let o=i[e];t[e]=Math.round((o<-1?-1:o>1?1:o)*127)}return t}var Vt={low:{N:25,quadPx:20,kMin:1.1,kMax:1.6,minQuad:8,maxUploads:6,buildMs:3},medium:{N:29,quadPx:15,kMin:1.3,kMax:2,minQuad:4,maxUploads:10,buildMs:4},high:{N:33,quadPx:11,kMin:1.5,kMax:2.5,minQuad:2,maxUploads:16,buildMs:4}},Ee=class{constructor({workers:t="auto"}={}){this.queue=[],this.inflight=new Map,this.done=[],this.nextId=1,this.requested=0,this.workers=[],this.workerLoad=[],this.syncOnly=!1;let e=0;if(t==="auto"){let o=typeof navigator<"u"&&navigator.hardwareConcurrency||4;e=Math.max(1,Math.min(4,o-2))}else e=t|0;typeof Worker>"u"&&(e=0);for(let o=0;o<e;o++)try{let s=Mo({type:"module"});s.onmessage=n=>this._onResult(o,n.data),s.onerror=n=>{console.warn("[terrain] worker error, falling back to main thread",n.message||n),this._killWorkers()},this.workers.push(s),this.workerLoad.push(0)}catch(s){console.warn("[terrain] module workers unavailable, building on the main thread",s),this._killWorkers();break}}_killWorkers(){for(let t of this.workers)try{t.terminate()}catch{}this.workers=[],this.workerLoad=[];for(let t of this.inflight.values())t.cancelled||this.queue.push(t);this.inflight.clear()}_onResult(t,e){this.workerLoad[t]=Math.max(0,(this.workerLoad[t]||0)-1);let o=this.inflight.get(e.id);if(this.inflight.delete(e.id),!(!o||o.cancelled)){if(e.error){console.error("[terrain] chunk build failed",e.error);return}this.done.push({job:o,data:e})}}request(t,e,o){t.id=this.nextId++,this.requested++;let s={req:t,priority:e,cb:o,cancelled:!1};return this.queue.push(s),s}cancel(t){t&&(t.cancelled=!0)}reclaimInflight(){for(let t of this.inflight.values())t.cancelled||this.queue.push(t);this.inflight.clear()}get busy(){return this.queue.length+this.inflight.size+this.done.length}pump(t,e,o=!1){let s=performance.now();if(this.queue.length&&(this.queue=this.queue.filter(a=>!a.cancelled),this.queue.sort((a,l)=>a.priority-l.priority)),this.workers.length&&!o){let a=0;for(let l=0;l<this.workers.length&&a<this.queue.length;l++)for(;this.workerLoad[l]<2&&a<this.queue.length;){let c=this.queue[a++];this.inflight.set(c.req.id,c),this.workerLoad[l]++,this.workers[l].postMessage(c.req)}a&&this.queue.splice(0,a)}else{let a=0;for(;this.queue.length&&(a===0||performance.now()-s<t);){let l=this.queue.shift();l.cancelled||(this.done.push({job:l,data:Ve(l.req)}),a++)}}let n=0;for(;this.done.length&&n<e;){let{job:a,data:l}=this.done.shift();a.cancelled||(a.cb(l),n++)}return n}dispose(){this._killWorkers(),this.queue=[],this.done=[]}},gs=`
float tspHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
// value noise on a lattice that tiles every 'per' cells (so it tiles in metres with the 1024 m detail period)
float tspVNoise(vec3 x, float per) {
  vec3 i = floor(x); vec3 f = x - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 a = mod(i, per), b = mod(i + 1.0, per);
  float n000 = tspHash(a), n100 = tspHash(vec3(b.x, a.y, a.z)), n010 = tspHash(vec3(a.x, b.y, a.z)), n110 = tspHash(vec3(b.x, b.y, a.z));
  float n001 = tspHash(vec3(a.x, a.y, b.z)), n101 = tspHash(vec3(b.x, a.y, b.z)), n011 = tspHash(vec3(a.x, b.y, b.z)), n111 = tspHash(b);
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z) * 2.0 - 1.0;
}
float tspFade(float cell, float foot) { return clamp(1.6 - foot * 3.0 / cell, 0.0, 1.0); }
// Integer matrices that are 3 × a rotation (Pythagorean quadruples): rotating an octave's domain breaks the value-noise
// lattice's axis alignment (square blotches under grazing light) while keeping the 1024 m period (integer entries map
// the period lattice onto itself). Scale 3 → the octave uses a 4× coarser lattice (features ≈ 1.33× the nominal cell).
const mat3 TSP_ROT_A = mat3(2.0, 2.0, -1.0, -1.0, 2.0, 2.0, 2.0, -1.0, 2.0);
const mat3 TSP_ROT_B = mat3(2.0, -1.0, 2.0, 2.0, 2.0, -1.0, -1.0, 2.0, 2.0);
// returns albedo modulation (x) and bump height in metres (y)
vec2 tspDetail(vec3 p, float foot) {
  float w0 = tspFade(128.0, foot), w1 = tspFade(32.0, foot), w2 = tspFade(8.0, foot), w3 = tspFade(2.0, foot), w4 = tspFade(0.5, foot);
  float w5 = tspFade(0.125, foot);
  vec2 r = vec2(0.0);
  float n;
  vec3 pa = TSP_ROT_A * p, pb = TSP_ROT_B * p;
  if (w0 > 0.0) { n = tspVNoise(p / 128.0, 8.0);   r += vec2(0.13, 2.5) * n * w0; }
  if (w1 > 0.0) { n = tspVNoise(pa / 128.0, 8.0);  r += vec2(0.1, 0.7) * n * w1; }
  if (w2 > 0.0) { n = tspVNoise(pb / 32.0, 32.0);  r += vec2(0.12, 0.22) * n * w2; }
  if (w3 > 0.0) { n = tspVNoise(pa / 8.0, 128.0);  r += vec2(0.11, 0.06) * n * w3; }
  if (w4 > 0.0) { n = tspVNoise(pb / 2.0, 512.0);  r += vec2(0.1, 0.018) * n * w4; }
  if (w5 > 0.0) { n = tspVNoise(pa / 0.5, 2048.0); r += vec2(0.09, 0.004) * n * w5; }
  return r;
}
#ifdef TSP_CRATERS
// Close-range crater field (cratered worlds): one octave of small craters on a lattice of 'cell' metres (tiles the
// 1024 m detail period; each cell holds at most one crater whose influence stays inside the 2×2×2 cells checked).
// Returns albedo modulation (x: darker floors, bright fresh ejecta) and height in metres (y: bowl + raised rim).
vec2 tspCraterOct(vec3 p, float cell, float foot, float seed) {
  float per = 1024.0 / cell;
  vec3 g = p / cell;
  vec3 b = floor(g - 0.5);
  vec2 r = vec2(0.0);
  for (int c = 0; c < 8; c++) {
    vec3 id = b + vec3(float(c % 2), float((c / 2) % 2), float(c / 4));
    vec3 iw = mod(id, per);
    if (tspHash(iw + seed) > uCraterDensity) continue;
    float h2 = tspHash(iw * 1.7 + seed + 11.3), h3 = tspHash(iw * 2.3 + seed + 5.1), h4 = tspHash(iw * 0.7 + seed + 23.7);
    vec3 cen = id + 0.25 + 0.5 * vec3(h2, h3, h4);
    float rad = 0.1 + 0.18 * h2 * h3;                      // in cells: many small, few big
    float x = length(g - cen) / rad;
    if (x > 1.9) continue;
    float rm = rad * cell;
    float vis = smoothstep(2.0, 6.0, rm / max(foot, 1e-4));
    // C¹-smooth profile (no slope jump at the rim → no hard outline): bowl x²(2 − x²) − 1, soft raised rim
    float x2 = min(x * x, 1.0);
    float bowl = (x2 * (2.0 - x2) - 1.0) * (0.16 + 0.1 * h4);
    float rim = 0.05 * (0.4 + 0.6 * h4) * exp(-(x - 1.0) * (x - 1.0) * 10.0);
    r.y += (bowl + rim) * rm * vis;
    r.x += (-0.05 * (1.0 - smoothstep(0.6, 1.05, x)) + 0.11 * h4 * h4 * smoothstep(0.8, 1.05, x) * (1.0 - smoothstep(1.05, 1.9, x))) * vis;
  }
  return r;
}
vec2 tspCraters(vec3 p, float foot) {
  vec2 r = vec2(0.0);
  // an octave is skipped once its biggest craters are < 2 px (keeps distant terrain cheap and alias-free)
  if (foot < 9.0) r += tspCraterOct(p, 64.0, foot, 3.7);
  #if TSP_CRATER_OCTS > 1
  if (foot < 2.3) r += tspCraterOct(p, 16.0, foot, 17.1);
  #endif
  #if TSP_CRATER_OCTS > 2
  if (foot < 0.6) r += tspCraterOct(p, 4.0, foot, 41.3);
  #endif
  return r;
}
#endif
// crisp anti-aliased fissure line from a signed, width-normalised field (|v| < 1 inside the fissure)
float tspFissure(float v) {
  float w = max(1.0, fwidth(v) * 1.2);
  float t = max(1.0 - abs(v) / w, 0.0);
  return t * t / w;
}
vec3 tspBump(vec3 surfPos, vec3 N, float h) {
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  // skip the bump on faces that disagree with the shading normal (LOD skirts seen through T-junction slivers)
  vec3 fn = normalize(cross(sx, sy));
  float ok = smoothstep(0.55, 0.8, abs(dot(fn, N)));
  vec3 R1 = cross(sy, N), R2 = cross(N, sx);
  float det = dot(sx, R1);
  vec2 dh = vec2(dFdx(h), dFdy(h)) * ok;
  vec3 grad = sign(det) * (dh.x * R1 + dh.y * R2);
  return normalize(abs(det) * N - grad);
}
`,Ho=`
uniform float uTime;
uniform vec3 uSunLightDirW;
uniform vec3 uSunColor;
uniform vec3 uAmbDay;
uniform vec3 uAmbNight;
uniform vec3 uShineDirW;
uniform vec3 uShineColor;
uniform vec3 uGlowColor;
uniform float uPixelAngle;
uniform float uDetail;
uniform vec2 uAerialMin;
uniform float uCraterDensity;
varying vec3 vDetail;
centroid varying vec2 vExtra;
varying vec3 vUpW;
varying vec3 vAtmoIn;
varying vec3 vAtmoT;
varying vec3 vSunT;
varying float vEcl;
varying float vCamDist;
`;function Io(i,t,{quality:e="high"}={}){let o=!!i.atmosphere,s=i.terrain?.palette?.accent,n=s?new Y(s).convertSRGBToLinear().multiplyScalar(3.5):new Y(0,0,0),a={uTime:{value:0},uSunLightDirW:{value:new g(1,0,0)},uSunColor:{value:new g(3,3,3)},uAmbDay:{value:new g(.3,.35,.45)},uAmbNight:{value:new g(.02,.022,.03)},uShineDirW:{value:new g(0,1,0)},uShineColor:{value:new g(0,0,0)},uGlowColor:{value:new g(n.r,n.g,n.b)},uPixelAngle:{value:.001},uDetail:{value:1},uAerialMin:{value:new Je(.45,.5)},uCraterDensity:{value:0}},l=i.terrain?.style,c=l==="cratered"||l==="desert";if(a.uCraterDensity.value=l==="cratered"?.6:.3,o){let h=i.atmosphere.pressureASL/101.325,f=Math.min(1,Math.max(0,(h-1)/3));a.uAerialMin.value.set(.45+(.8-.45)*f,.5+.5*f)}let u=new uo({vertexColors:!0,shininess:12,specular:new Y(.02,.02,.02)});u.name=`terrain:${i.id}`;let d=i.terrain?.style==="scorched";u.defines={AERIAL_STEPS:e==="low"?4:e==="medium"?5:6,TSP_TERRAIN:1},o&&(u.defines.HAS_ATMO=1);let r=!!i.atmosphere&&i.terrain?.style==="earthlike";return r&&(u.defines.HAS_CLOUDS=1),d&&(u.defines.TSP_FISSURES=1),c&&(u.defines.TSP_CRATERS=1,u.defines.TSP_CRATER_OCTS=e==="low"?1:e==="medium"?2:3),u.defines.TSP_EXT_SCALE=d?po.toFixed(1):"1.0",u.userData.uniforms=a,u.customProgramCacheKey=()=>`tsp-terrain-${o?1:0}-${d?1:0}-${r?1:0}-${c?1:0}-${e}`,u.onBeforeCompile=h=>{Object.assign(h.uniforms,t,a),h.vertexShader=h.vertexShader.replace("#include <common>",`#include <common>
${gt}
${r?Yt:""}
${Ho}
attribute vec3 aDetail;
${d?`attribute vec3 aExtra;
varying float vHot;`:"attribute vec2 aExtra;"}`).replace("#include <color_vertex>",`#include <color_vertex>
  vColor.rgb *= vColor.rgb;   // colours are stored √-encoded in uint8`).replace("#include <fog_vertex>",`#include <fog_vertex>
  {
    vec4 tw = modelMatrix * vec4(transformed, 1.0);
    vDetail = aDetail;
    vExtra = aExtra.xy * TSP_EXT_SCALE;
  #ifdef TSP_FISSURES
    vHot = aExtra.z;
  #endif
    vec3 rel = (tw.xyz - uBodyCenter) * uInvR;
    float rr = length(rel);
    vUpW = rel / rr;
    vCamDist = length(tw.xyz - cameraPosition);
    float tspSunUp = dot(vUpW, uSunDirW);
    vEcl = atmoEclipse(rel);             // shadows of moons / the parent planet (eclipses)
  #ifdef HAS_ATMO
    atmoAerial(cameraPosition, tw.xyz, AERIAL_STEPS, vAtmoIn, vAtmoT);
    vSunT = atmoSunTransmittance(rr, tspSunUp) * vEcl;
    #ifdef HAS_CLOUDS
    {
      // cloud shadow: sample the deck where the sun ray from this vertex crosses it
      vec3 dF = uBodyRotInv * vUpW, sF = uBodyRotInv * uSunDirW;
      float t = max(uCloudR - rr, 0.0) / max(tspSunUp, 0.1);
      float cov = cloudCoverage(normalize(dF + sF * t), 4);
      vSunT *= 1.0 - 0.62 * cov * smoothstep(0.0, 0.08, tspSunUp) * step(rr, uCloudR);
    }
    #endif
  #else
    vAtmoIn = vec3(0.0); vAtmoT = vec3(1.0);
    // airless: the body's own shadow. The sun must clear the geometric horizon of the mean sphere (peaks see further:
    // dip = acos(1/r)), soft over the sun's disc — otherwise slopes tilted sunwards stay lit deep into the night.
    float tspDip = rr > 1.0 ? acos(1.0 / rr) : 0.0;
    vSunT = vec3(smoothstep(-uSunAngR, uSunAngR, asin(clamp(tspSunUp, -1.0, 1.0)) + tspDip) * vEcl);
  #endif
  }`);let f=so.lights_fragment_begin.replace("getDirectionalLightInfo( directionalLight, directLight );",`getDirectionalLightInfo( directionalLight, directLight );
		if ( dot( directLight.direction, tspSunLightV ) > 0.9995 ) {
			directLight.direction = tspSunV;
			directLight.color = uSunColor * vSunT;
		}`);h.fragmentShader=h.fragmentShader.replace("#include <common>",`#include <common>
${gt}
${o?Zt:""}
${Ho}
${d?"varying float vHot;":""}
${gs}`).replace("#include <color_fragment>",`#include <color_fragment>
  // metres per pixel from the screen-space derivatives (anisotropic: correct at grazing angles too)
  float tspFoot = max(length(dFdx(vDetail)), length(dFdy(vDetail)));
  #ifdef TSP_FISSURES
    // fissure lines only where the mesh can resolve them: the fine network (≈ 2.6 km apart, 80 m wide) fades out
    // beyond ~25–80 m per pixel, the major one (≈ 9 km apart) beyond ~100–300 m; further away a soft glow over the hot
    // plains replaces them — no line lattice aliasing into a grid from orbit
    float tspVisB = 1.0 - smoothstep(25.0, 80.0, tspFoot);
    float tspVisA = 1.0 - smoothstep(100.0, 300.0, tspFoot);
    float tspFa = tspFissure(vExtra.x) * tspVisA, tspFb = tspFissure(vExtra.y) * 0.75 * tspVisB;
    float tspF = max(tspFa, tspFb);
    float tspEdge = max(tspFissure(vExtra.x * 0.45) * tspVisA, tspFissure(vExtra.y * 0.45) * 0.75 * tspVisB);
    diffuseColor.rgb *= 1.0 - 0.75 * tspEdge;
    float tspFar = clamp(vHot, 0.0, 1.0) * (1.0 - tspVisA);
  #endif
  vec2 tspD = tspDetail(vDetail, tspFoot) * uDetail;
  #ifdef TSP_CRATERS
  tspD += tspCraters(vDetail, tspFoot) * uDetail;
  #endif
  diffuseColor.rgb *= 1.0 + tspD.x * 1.6;
  diffuseColor.rgb *= mix(vec3(1.0), vec3(1.04, 1.0, 0.93), clamp(tspD.x * 4.0, -1.0, 1.0));
  // vegetation: dry/yellow vs lush/dark tufts where the ground is green
  float tspVeg = smoothstep(0.02, 0.12, diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
  diffuseColor.rgb *= mix(vec3(1.0), mix(vec3(0.82, 0.95, 0.8), vec3(1.25, 1.1, 0.72), clamp(tspD.x * 5.0 + 0.5, 0.0, 1.0)), tspVeg * 0.6);
  vec3 tspSunLightV = normalize((viewMatrix * vec4(uSunLightDirW, 0.0)).xyz);
  vec3 tspSunV = normalize((viewMatrix * vec4(uSunDirW, 0.0)).xyz);
  vec3 tspUpV = normalize((viewMatrix * vec4(vUpW, 0.0)).xyz);`).replace("#include <normal_fragment_maps>",`#include <normal_fragment_maps>
  normal = tspBump(-vViewPosition, normal, tspD.y);`).replace("#include <emissivemap_fragment>",`#include <emissivemap_fragment>
  #ifdef TSP_FISSURES
  {
    float pulse = 0.82 + 0.18 * sin(uTime * 1.3 + vDetail.x * 0.07 + vDetail.z * 0.05);
    vec3 hot = mix(uGlowColor, vec3(1.0, 0.78, 0.35) * length(uGlowColor), tspF * tspF * tspF);
    totalEmissiveRadiance += hot * tspF * pulse + uGlowColor * (tspFar * tspFar * 0.022);
  }
  #endif`).replace("#include <lights_phong_fragment>",`#include <lights_phong_fragment>
  #ifdef TSP_FISSURES
  material.specularColor = vec3(0.02);
  material.specularShininess = 20.0;
  #else
  {
    // gloss clamped (never trust an interpolated varying to stay in range) and shininess ≥ 1 (pow(0, ≤0) is Inf/NaN)
    float tspGloss = clamp(vExtra.y, 0.0, 1.0);
    material.specularColor = vec3(0.015 + 0.5 * tspGloss);
    material.specularShininess = max(mix(10.0, 180.0, tspGloss), 1.0);
  }
  #endif`).replace("#include <lights_fragment_begin>",f).replace("#include <lights_fragment_maps>",`#include <lights_fragment_maps>
  #if defined( RE_IndirectDiffuse )
  {
    float sunUp = dot(vUpW, uSunDirW);
    float skyVis = 0.62 + 0.38 * dot(normal, tspUpV);
  #ifdef HAS_ATMO
    // sky light for the local sun elevation (precomputed from the same scattering model as the sky), with a gentle
    // twilight lift for readability that never exceeds the noon value (uAmbDay)
    float dusk = smoothstep(-0.25, 0.0, sunUp) * (1.0 - smoothstep(0.05, 0.35, sunUp));
    vec3 tspSky = min(skyLut(sunUp, 0.0) * (uAmbScale * (1.0 + 1.6 * dusk)), uAmbDay);
  #else
    // airless: light bounced by the sunlit surroundings, gone once the sun has set
    vec3 tspSky = uAmbDay * smoothstep(-0.03, 0.25, sunUp);
  #endif
    // planetshine from the parent body (earthshine on moons), fades as the parent sinks below the horizon
    vec3 tspShineV = normalize((viewMatrix * vec4(uShineDirW, 0.0)).xyz);
    vec3 tspShine = uShineColor * (max(dot(normal, tspShineV), 0.0) * smoothstep(-0.12, 0.12, dot(vUpW, uShineDirW)));
    irradiance = (tspSky * vEcl + uAmbNight) * skyVis + tspShine;
  }
  #endif`).replace("#include <opaque_fragment>",`
  #ifdef HAS_ATMO
  {
    // aerial perspective. Single-scattering in-scatter over short, low paths (ascent views at 5–20 km, the ground seen
    // from orbit) is a very saturated blue that turned green land teal; its weight and saturation now grow with the
    // path's optical depth, so the ground keeps its hue up close and still melts into the horizon haze far away.
    float tspTm = (vAtmoT.r + vAtmoT.g + vAtmoT.b) / 3.0;
    float tspK = smoothstep(0.25, 1.5, -log(max(tspTm, 1e-4)));
    // (uAerialMin: weight / saturation for thin paths — thick "Eve-like" atmospheres keep their haze on purpose)
    vec3 tspIn = mix(vec3(dot(vAtmoIn, vec3(0.2126, 0.7152, 0.0722))), vAtmoIn, mix(uAerialMin.y, 1.0, tspK)) * mix(uAerialMin.x, 0.85, tspK);
    outgoingLight = outgoingLight * mix(vec3(tspTm), vAtmoT, mix(uAerialMin.y, 1.0, tspK)) + tspIn;
  }
  #endif
  #include <opaque_fragment>`)},u}var zo=new Map;function xs(i){let t=zo.get(i);return t||(t=new at(ko(i),1),zo.set(i,t)),t}var xe=new Float64Array(3);function ys(){this.array=null}var At=class{constructor(t,e,o,s,n,a){this.lod=t,this.face=e,this.level=o,this.ix=s,this.iy=n,this.parent=a,this.children=null,this.mesh=null,this.ocean=null,this.state=0,this.job=null,this.arc=Jt(t.R,o);let l=2/(1<<o);ge(e,-1+(s+.5)*l,-1+(n+.5)*l,xe),this.cx=xe[0]*t.R,this.cy=xe[1]*t.R,this.cz=xe[2]*t.R,this.radius=this.arc*.75,this.minH=0,this.maxH=0,this.shown=!1}},te=class i{constructor(t,{quality:e="high",material:o,oceanMaterial:s=null,service:n,parent:a}){this.body=t,this.gen=Kt(t.id),this.R=t.radius,this.q=Vt[e]||Vt.high,this.N=this.q.N,this.material=o,this.oceanMaterial=s,this.service=n,this.group=new mt,this.group.name=`terrain:${t.id}`,a.add(this.group);let l=Jt(this.R,0);this.maxLevel=Math.max(1,Math.ceil(Math.log2(l/(this.N-1)/this.q.minQuad))),this.roots=[];for(let c=0;c<6;c++)this.roots.push(new At(this,c,0,0,0,null));this.stats={nodes:6,visible:0,building:0,maxLevelShown:0},this.occR=this.R+(this.gen.ocean?-30:this.gen.minHeight),this.camAlt=1/0,this.splitK=2,this.visible=!0,this._index=xs(this.N)}buildRootsSync(){for(let t of this.roots){if(t.state===2)continue;let e=Ve({id:0,bodyId:this.body.id,face:t.face,level:0,ix:0,iy:0,N:this.N});this._apply(t,e)}}get ready(){return this.roots.every(t=>t.state===2)}_request(t,e){t.state===0&&(t.state=1,t.job=this.service.request({bodyId:this.body.id,face:t.face,level:t.level,ix:t.ix,iy:t.iy,N:this.N},e,o=>{t.job=null,t.state===1&&this._apply(t,o)}))}_makeGeometry(t,e,o,s,n,a,l,c,u=2){let d=new Dt,r=(h,f,m=!1)=>new at(h,f,m).onUpload(ys);return d.setAttribute("position",r(t,3)),d.setAttribute("normal",r(e,3,!0)),d.setAttribute("aDetail",r(s,3)),l?d.setAttribute("aDepth",r(c,1)):(d.setAttribute("color",r(o,3,!0)),d.setAttribute("aExtra",r(n,u,!0))),d.setIndex(this._index),d.boundingSphere=new zt(new g,a),d}_apply(t,e){if(t.state=2,t.cx=e.center[0],t.cy=e.center[1],t.cz=e.center[2],t.radius=Math.max(e.radius,e.ocean?e.ocean.radius:0),t.minH=e.minH,t.maxH=e.maxH,!(this.gen.ocean&&e.maxH<-400&&e.ocean)){let s=this._makeGeometry(e.pos,e.nor,e.col,e.det,e.ext,e.radius,!1,null,e.extSize||2),n=new nt(s,this.material);n.position.set(t.cx,t.cy,t.cz),n.matrixAutoUpdate=!1,n.updateMatrix(),n.receiveShadow=!0,n.castShadow=!1,n.visible=!1,n.name=`chunk ${t.face}/${t.level}/${t.ix},${t.iy}`,t.mesh=n,this.group.add(n)}if(e.ocean&&this.oceanMaterial){let s=e.ocean,n=this._makeGeometry(s.pos,s.nor,null,s.det,null,s.radius,!0,s.depth),a=new nt(n,this.oceanMaterial);a.position.set(t.cx,t.cy,t.cz),a.matrixAutoUpdate=!1,a.updateMatrix(),a.renderOrder=-60,a.visible=!1,t.ocean=a,this.group.add(a)}}_disposeNode(t){if(t.children){for(let e of t.children)this._disposeNode(e);t.children=null,this.stats.nodes-=4}t.job&&(this.service.cancel(t.job),t.job=null);for(let e of["mesh","ocean"]){let o=t[e];o&&(this.group.remove(o),o.geometry.index=null,o.geometry.dispose(),t[e]=null)}t.state=0}_show(t,e){t.shown!==e&&(t.shown=e,t.mesh&&(t.mesh.visible=e),t.ocean&&(t.ocean.visible=e))}_hideSubtree(t){if(this._show(t,!1),t.children)for(let e of t.children)this._hideSubtree(e)}update(t,e,o,s=.0016){this._cx=t,this._cy=e,this._cz=o;let n=Math.sqrt(t*t+e*e+o*o)-this.R,a=Math.min(1,Math.max(0,(n-.3*this.R)/(2.7*this.R))),l=a*a*(3-2*a),c=1/((this.N-1)*s*this.q.quadPx*(1-.65*l)),u=this.q.kMax*(1+14*l);this.splitK=Math.min(u,Math.max(this.q.kMin,c));let d=Math.sqrt(t*t+e*e+o*o);this._camR=d,this.camAlt=d-this.R,this._hz=d>this.occR?Math.sqrt(d*d-this.occR*this.occR):0,this.stats.visible=0,this.stats.maxLevelShown=0;for(let r of this.roots)this._visit(r);this.stats.building=this.service.busy}_horizonVisible(t){if(!i.horizonCulling||this._camR<=this.occR)return!0;let e=t.cx-this._cx,o=t.cy-this._cy,s=t.cz-this._cz,n=Math.sqrt(e*e+o*o+s*s)-t.radius;if(n<=0)return!0;let a=this.R+Math.max(t.maxH,0)+50,l=this._hz+(a>this.occR?Math.sqrt(a*a-this.occR*this.occR):0);return n<l}_visit(t){let e=t.cx-this._cx,o=t.cy-this._cy,s=t.cz-this._cz,n=Math.max(0,Math.sqrt(e*e+o*o+s*s)-t.arc*.6),a=this.splitK*t.arc;if(t.level<this.maxLevel&&t.state===2&&(n<a||t.children&&n<a*1.15)){if(!t.children){let r=t.level+1,h=t.ix*2,f=t.iy*2;t.children=[new At(this,t.face,r,h,f,t),new At(this,t.face,r,h+1,f,t),new At(this,t.face,r,h,f+1,t),new At(this,t.face,r,h+1,f+1,t)],this.stats.nodes+=4}let d=!0;for(let r of t.children)if(r.state!==2){d=!1;let h=r.cx-this._cx,f=r.cy-this._cy,m=r.cz-this._cz;this._request(r,Math.sqrt(h*h+f*f+m*m)/r.arc+r.level*.25)}if(d){this._show(t,!1);for(let r of t.children)this._visit(r);return}for(let r of t.children)this._hideSubtree(r)}else if(t.children){this.stats.nodes-=4;for(let d of t.children)this._disposeNode(d);t.children=null}let u=this._horizonVisible(t);this._show(t,u),u&&(this.stats.visible++,t.level>this.stats.maxLevelShown&&(this.stats.maxLevelShown=t.level))}setVisible(t){this.group.visible=t,this.visible=t}dispose(){for(let t of this.roots)this._disposeNode(t);this.group.removeFromParent()}};te.horizonCulling=!0;var ws={cratered:{kind:"rock",density:.34,sMin:.12,sMax:1.9,rough:.92,metal:0,tint:.85},desert:{kind:"rock",density:.22,sMin:.12,sMax:1.5,rough:.9,metal:0,tint:.8},scorched:{kind:"rock",density:.3,sMin:.12,sMax:1.6,rough:.85,metal:.05,tint:.55},flats:{kind:"crystal",density:.1,sMin:.15,sMax:1.1,rough:.12,metal:.1,tint:1.05}},Do=5,Ge=170,Ie=2400,Lo=[180,320],ye=new wt,Es=new g,bs=new g,Po=new ie,Fo=new wt,Vo=new wt,Rs=new g,Go=new g,Ms=new g,we=new Float64Array(3),Ft={height:0,color:[0,0,0],biome:"",water:!1,glow:0,gloss:0};function Ts(i){let t;if(i==="crystal")t=new lo(1,0),t.scale(.32,1.25,.32),t.translate(0,.55,0);else{t=new ro(1,1);let e=t.attributes.position;for(let o=0;o<e.count;o++){let s=e.getX(o),n=e.getY(o),a=e.getZ(o),l=.78+.4*vt(Math.round(s*97),Math.round(n*97),Math.round(a*97),5,1);e.setXYZ(o,s*l,n*l*.62,a*l)}}return t.index&&(t=t.toNonIndexed()),t.computeVertexNormals(),t}var be=class{constructor(t,e){if(this.body=t,this.R=t.radius,this.style=ws[t.terrain?.style]||null,this.cache=new Map,this.anchor=new g,this._last=new g(1/0,0,0),this._lastFade=-1,this.mesh=null,!this.style)return;let o=this.style,s=new co({roughness:o.rough,metalness:o.metal,flatShading:!0});s.name=`scatter:${t.id}`,this.mesh=new no(Ts(o.kind),s,Ie),this.mesh.name=`scatter:${t.id}`,this.mesh.count=0,this.mesh.castShadow=!0,this.mesh.receiveShadow=!0,this.mesh.frustumCulled=!1,this.mesh.visible=!1,this.mesh.setColorAt(0,new Y(1,1,1)),e.add(this.mesh)}update(t,e,o,s,n,a){if(!this.mesh)return;let l=this.R,c=Math.sqrt(t*t+e*e+o*o),u=t/c,d=e/c,r=o/c,h=this._groundH(u,d,r),f=c-l-h,m=1-Ue(Lo[0],Lo[1],f);if(m<=0){this.mesh.visible=!1;return}this.mesh.visible=!0;let v=u*(l+h),y=d*(l+h),E=r*(l+h);Math.hypot(v-this._last.x,y-this._last.y,E-this._last.z)<12&&Math.abs(m-this._lastFade)<.05||(this._last.set(v,y,E),this._lastFade=m,this.anchor.set(v,y,E),this.mesh.position.copy(this.anchor),this._rebuild(u,d,r,v,y,E,s,n,a,m))}_groundH(t,e,o){return Kt(this.body.id).height(t,e,o)}_key(t,e,o){return t*1e12+(e+5e5)*1e6+(o+5e5)}_cell(t,e,o,s){let n=this._key(t,e,o),a=this.cache.get(n);if(a!==void 0)return a;let l=this.style,c=this.body.terrain.seed|0;if(a=null,vt(e,o,t,c,0)<l.density){let u=(e+.15+.7*vt(e,o,t,c,1))*s,d=(o+.15+.7*vt(e,o,t,c,2))*s;if(Math.abs(u)<=1&&Math.abs(d)<=1){ge(t,u,d,we);let r=we[0],h=we[1],f=we[2];if(ce(this.body.id,r,h,f,Ft),Ft.glow>.12)return this.cache.set(this._key(t,e,o),null),null;let m=vt(e,o,t,c,3),v=l.sMin+(l.sMax-l.sMin)*m*m*m,y=this.R+Ft.height,E=l.tint*(.8+.35*vt(e,o,t,c,4));a={x:r*y,y:h*y,z:f*y,ux:r,uy:h,uz:f,size:v,yaw:vt(e,o,t,c,5)*Math.PI*2,tilt:(vt(e,o,t,c,6)-.5)*(l.kind==="crystal"?1.1:.5),r:Math.min(1,Ft.color[0]*E),g:Math.min(1,Ft.color[1]*E),b:Math.min(1,Ft.color[2]*E)}}}return this.cache.set(n,a),a}_rebuild(t,e,o,s,n,a,l,c,u,d){let r=this.R,h=this.style,f=Do/(r*Math.PI/4),m=Math.ceil(Ge*1.45/Do),v=Ge*Ge,y=new Y,E=bs,R=Es.set(0,1,0),D=0,S=new Set;for(let L=0;L<6;L++){let G=Fe[L],C=t*G.n[0]+e*G.n[1]+o*G.n[2];if(C<.5)continue;let W=(t*G.u[0]+e*G.u[1]+o*G.u[2])/C,U=(t*G.v[0]+e*G.v[1]+o*G.v[2])/C,_=Math.atan(W)/(Math.PI/4),V=Math.atan(U)/(Math.PI/4);if(Math.abs(_)>1+m*f*2||Math.abs(V)>1+m*f*2)continue;let O=Math.floor(_/f),j=Math.floor(V/f);for(let X=j-m;X<=j+m&&D<Ie;X++)for(let N=O-m;N<=O+m&&D<Ie;N++){let A=this._cell(L,N,X,f);if(S.add(this._key(L,N,X)),!A)continue;let P=A.x-s,B=A.y-n,ut=A.z-a,Z=P*P+B*B+ut*ut;if(Z>v)continue;let st=Math.hypot(A.x-l,A.y-c,A.z-u),p=A.size*d*(1-Ue(v*.55,v,Z))*Ue(2.5,6,st);if(p<.02)continue;E.set(A.ux,A.uy,A.uz),ye.setFromUnitVectors(R,E),Fo.setFromAxisAngle(E,A.yaw),Vo.setFromAxisAngle(Rs.set(1,0,0).applyQuaternion(ye),A.tilt),ye.premultiply(Fo).premultiply(Vo);let k=h.kind==="crystal"?.25:.3;Go.set(P-A.ux*p*k,B-A.uy*p*k,ut-A.uz*p*k),Po.compose(Go,ye,Ms.set(p,p,p)),this.mesh.setMatrixAt(D,Po),this.mesh.setColorAt(D,y.setRGB(A.r,A.g,A.b)),D++}}if(this.cache.size>3e4)for(let L of this.cache.keys())S.has(L)||this.cache.delete(L);this.mesh.count=D,this.mesh.instanceMatrix.needsUpdate=!0,this.mesh.instanceColor&&(this.mesh.instanceColor.needsUpdate=!0)}setVisible(t){this.mesh&&!t&&(this.mesh.visible=!1)}dispose(){this.mesh&&(this.mesh.removeFromParent(),this.mesh.geometry.dispose(),this.mesh.material.dispose(),this.mesh.dispose?.(),this.cache.clear())}};function Ue(i,t,e){let o=(e-i)/(t-i);return o=o<0?0:o>1?1:o,o*o*(3-2*o)}var Rt;try{if(Rt=await import("./chunk-GW3ICAIN.js"),typeof Rt.bodyPosition!="function"||typeof Rt.rotationQuat!="function")throw new Error("universe.js incomplete")}catch(i){console.warn("[planets] src/physics/universe.js unavailable — using the worlds fallback ephemeris",i?.message||i),Rt=await import("./chunk-SCK5GDQF.js")}var Gt=3.3,dt=(()=>{let i=Pt(ht.verda),t=[1,.965,.92];if(!i)return new Y(...t);let o=fe(i,1,1,[0,0,0]).map(n=>1/Math.max(n,.001)),s=1/o[1];return new Y(t[0]*o[0]*s,t[1]*o[1]*s,t[2]*o[2]*s)})(),It=new g,rt=new g,Ut=new g,ee=new wt,Ss=new ie,_s=new Y,lt=[0,0,0],ft=[0,0,0],bt={height:0,color:[0,0,0],biome:"",water:!1,glow:0,gloss:0},As=[.04,.05,.085],ks=[.03,.034,.045],Ne=[.012,.014,.02],ct=[.012,.016,.03],Cs=.3,Hs=120,zs=.25;function Nt(i,t,e,o,s,n){return De(i,t,e,o,s,me,n),n[0]*=dt.r,n[1]*=dt.g,n[2]*=dt.b,n}function qe(i){return i[0]*.2126+i[1]*.7152+i[2]*.0722}function pt(i,t,e){let o=(e-i)/(t-i);return o=o<0?0:o>1?1:o,o*o*(3-2*o)}var Ds=`
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`,Ls=`
uniform vec3 uUp;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uLimb;
uniform float uHorizonCos;   // directions with dot(d, up) < -uHorizonCos see the planet
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float e = dot(d, uUp);
  vec3 col;
  float edge = e + uHorizonCos;
  if (edge < 0.0) {
    col = uGround * (0.75 + 0.25 * smoothstep(-0.4, 0.0, edge));
  } else {
    float t = clamp(edge / max(1.0 - (-uHorizonCos), 1e-3), 0.0, 1.0);
    col = mix(uHorizon, uZenith, pow(t, 0.45));
    col += uLimb * exp(-edge * 18.0);
  }
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(s, 900.0) * 30.0 + pow(s, 24.0) * 0.25);
  gl_FragColor = vec4(col, 1.0);
}
`,We=class{constructor(t,e){let o=ht[e];this.id=e,this.body=o,this.sys=t,this.rootPos=new g,this.quat=new wt,this.group=new mt,this.group.name=`body:${e}`,this.fixed=new mt,this.fixed.name=`bodyFixed:${e}`,this.group.add(this.fixed),this.color=new Y(o.color).convertSRGBToLinear(),this.atmoParams=Pt(o),this.uniforms=xo(o),this.lod=null,this.shell=null,this.terrainMat=null,this.oceanMat=null,this.scatter=null,this.angPx=0,this.dist=1/0;let s=t.quality;o.terrain&&(this.terrainMat=Io(o,this.uniforms,{quality:s}),o.terrain.ocean&&(this.oceanMat=bo(o,this.uniforms,{quality:s})),this.lod=new te(o,{quality:s,material:this.terrainMat,oceanMaterial:this.oceanMat,service:t.service,parent:this.fixed}),this.lod.buildRootsSync()),o.atmosphere&&(this.shell=new ue(o,this.uniforms,{quality:s}),this.group.add(this.shell.mesh)),this.clouds=null,this.atmoParams?.clouds&&(this.clouds=new he(o,this.uniforms,{quality:s}),this.fixed.add(this.clouds.mesh));let n=this.atmoParams,a=[0,0,0],l=[0,0,0];if(n&&(Nt(n,1.00001,1,.8,.8,a),Nt(n,1.00001,.04,.8,.5,l)),this.skyZenith=new g(...a),this.skyHorizon=new g(...l),this.skyLut=null,this.skyLutTex=null,this.ambScale=1,n){this.ambDay=new g(...a).multiplyScalar(Math.PI*.8).addScaledVector(new g(...l),Math.PI*.4),this.skyLut=yo(n,[dt.r,dt.g,dt.b]),this.skyLutTex=wo(this.skyLut);let r=pe(this.skyLut,0,.8,[0,0,0]);this.ambScale=qe([this.ambDay.x,this.ambDay.y,this.ambDay.z])/Math.max(qe(r),1e-6),this.uniforms.uSkyLut.value=this.skyLutTex,this.uniforms.uAmbScale.value=this.ambScale}else this.ambDay=new g(.11,.11,.115);this.ambNight=n?new g(.075,.085,.13):new g(.05,.052,.06);let c=o.parent&&ht[o.parent];this.shineSrc=c&&c.type!=="star"?c.id:null;let u=new Y(c?c.color:"#ffffff").convertSRGBToLinear(),d=Math.max(u.r,u.g,u.b,.001);if(this.shineTint=new g(.5+.5*u.r/d,.5+.5*u.g/d,.5+.5*u.b/d),this.shineE=new g,this.shineDir=new g(0,1,0),this.oceanMat&&this.oceanMat.uniforms.uAmbNight.value.copy(this.ambNight).multiplyScalar(.12),this.terrainMat){let r=this.terrainMat.userData.uniforms;r.uAmbDay.value.copy(this.ambDay),r.uAmbNight.value.copy(this.ambNight)}if(this.clouds){let r=this.clouds.material.uniforms;r.uAmbDay.value.copy(this.ambDay),r.uAmbNight.value.copy(this.ambNight)}}skyIrradiance(t,e){if(!this.skyLut)return e[0]=e[1]=e[2]=0,e;pe(this.skyLut,0,t,e);let o=pt(-.25,0,t)*(1-pt(.05,.35,t)),s=this.ambScale*(1+1.6*o);return e[0]=Math.min(e[0]*s,this.ambDay.x),e[1]=Math.min(e[1]*s,this.ambDay.y),e[2]=Math.min(e[2]*s,this.ambDay.z),e}ownsChild(t){return t===this.lod?.group||t===this.clouds?.mesh||t===this.scatter?.mesh}dispose(){this.lod?.dispose(),this.scatter?.dispose(),this.shell?.dispose(),this.clouds?.dispose(),this.terrainMat?.dispose(),this.oceanMat?.dispose(),this.skyLutTex?.dispose(),this.group.removeFromParent()}},Uo=class{constructor(t,{quality:e=fo.settings.graphics||"high",workers:o="auto"}={}){this.renderer=t,this.quality=Vt[e]?e:"high",this.root=new mt,this.root.name="PlanetSystem",this.shadowExtent=40,this._shadowExtentApplied=-1,this.service=new Ee({workers:o}),this.time=0,this._lastNow=performance.now(),this._forceSync=!1,this.nearestBody="verda",this.cameraAltitude=0,this.sunDirection=new g(1,0,0),this._origin=new g,this._originFixed=new g,this._camWorld=new g,this._camRoot=new g,this._sunRoot=new g,this._up=new g(0,1,0),this._skyCol=new g,this._groundCol=new g,this.skyColor=new Y(0,0,0);let s=He.filter(a=>ht[a].type!=="star");this.sky=new ve(t,{quality:this.quality,bodyIds:s}),this.root.add(this.sky.group),this._buildBodies(),this.starGroup=new mt,this.starGroup.name="body:sola",this.starFixed=new mt,this.starFixed.name="bodyFixed:sola",this.starGroup.add(this.starFixed),this.root.add(this.starGroup),this._starQuat=new wt,this.sunLight=new mo(dt.clone(),Gt),this.sunLight.name="sunLight",this.sunLight.castShadow=!0;let n=this.quality==="high"?2048:this.quality==="medium"?1536:1024;this.sunLight.shadow.mapSize.set(n,n),this.sunLight.shadow.bias=-3e-4,this.sunLight.shadow.normalBias=.02,this.sunLight.shadow.radius=2,this.root.add(this.sunLight,this.sunLight.target),this.hemiLight=new ho(9417983,3885612,.6),this.hemiLight.name="ambientHemi",this.root.add(this.hemiLight),this.hemiScale=1,this._initEnv();try{typeof window<"u"&&window.TSP&&(window.TSP.worlds={planets:this})}catch{}}_buildBodies(){this.bodies=new Map;for(let t of He){if(ht[t].type==="star")continue;let e=new We(this,t);this.bodies.set(t,e),this.root.add(e.group)}}_initEnv(){this.envScene=new re,this.envMat=new it({uniforms:{uUp:{value:new g(0,1,0)},uSunDir:{value:new g(1,1,0).normalize()},uSunColor:{value:new g(1,1,1)},uZenith:{value:new g(.1,.2,.5)},uHorizon:{value:new g(.4,.5,.6)},uGround:{value:new g(.08,.1,.05)},uLimb:{value:new g},uHorizonCos:{value:0}},vertexShader:Ds,fragmentShader:Ls,side:_t,depthWrite:!1,depthTest:!1}),this.envGeo=new jt(10,48,24),this.envScene.add(new nt(this.envGeo,this.envMat)),this.envCubeRT=new ne(64,{type:Ht}),this.envCam=new ae(.1,100,this.envCubeRT),this.pmrem=new io(this.renderer),this.envRT=null,this._envKey=null,this._envTimer=0,this._envSetOn=null,this._renderEnv(!0)}_renderEnv(){let t=this.renderer,e=t.toneMapping;t.toneMapping=oe;try{this.envCam.update(t,this.envScene),this.envRT=this.pmrem.fromCubemap(this.envCubeRT.texture,this.envRT||null)}finally{t.toneMapping=e}}get envMap(){return this.envRT?this.envRT.texture:null}bodyFixedGroup(t){let e=this.bodies.get(t);if(e)return e.fixed;if(ht[t]?.type==="star")return this.starFixed;throw new Error("PlanetSystem.bodyFixedGroup: unknown body "+t)}setVisible(t){this.root.visible=!!t}setQuality(t){if(!Vt[t]||t===this.quality)return;this.quality=t;let e=new Map;for(let[o,s]of this.bodies)e.set(o,s.fixed.children.filter(n=>!s.ownsChild(n)));for(let o of this.bodies.values())o.dispose();this._buildBodies();for(let[o,s]of e)for(let n of s)this.bodies.get(o).fixed.add(n)}prewarm(t,e,o,s=2500){let n=performance.now();this._forceSync=!0,this.service.reclaimInflight();try{for(let a=0;a<600;a++){let l=this.service.requested;if(this.update(t,e,o),this.service.requested===l&&this.service.busy===0||performance.now()-n>s)break}}finally{this._forceSync=!1}return performance.now()-n}stats(){let t={building:this.service.busy,workers:this.service.workers.length,bodies:{}};for(let[e,o]of this.bodies)o.lod&&o.group.visible&&(t.bodies[e]={...o.lod.stats,angPx:Math.round(o.angPx)});return t}getSkyColor(t){let e=this.skyColor.setRGB(0,0,0),o=null,s=1/0;for(let d of this.bodies.values()){if(!d.atmoParams)continue;let h=It.subVectors(t,d.rootPos).length()-d.body.radius;h<d.body.atmosphere.height*1.5&&h<s&&(o=d,s=h)}if(!o)return e;let n=It.subVectors(t,o.rootPos).normalize(),a=rt.subVectors(this._sunRoot,o.rootPos).normalize(),l=n.dot(a),c=Math.max(1.000001,(s+o.body.radius)/o.body.radius),u=o.atmoParams;return Nt(u,c,.08,l,Math.sqrt(Math.max(0,1-l*l))*.5,lt),Nt(u,c,.6,l,l*.6,ft),e.setRGB((lt[0]+ft[0])*.5,(lt[1]+ft[1])*.5,(lt[2]+ft[2])*.5)}update(t,e,o){if(this._disposed)return;let s=performance.now(),n=Math.min(.1,(s-this._lastNow)/1e3);this._lastNow=s,this.time+=n,t.updateMatrixWorld();let a=this._origin.copy(e),l=this._camWorld.setFromMatrixPosition(t.matrixWorld),c=this._camRoot.copy(a).add(l),u=this.renderer.domElement.height||720,d=(t.isPerspectiveCamera?t.fov:60)*Math.PI/180,r=2*Math.tan(d/2)/u,h=this.renderer.getPixelRatio?.()||1,f=Rt.bodyPosition("sola",o,this._sunRoot);this.starGroup.position.subVectors(f,a),this.starFixed.quaternion.copy(Rt.rotationQuat("sola",o,this._starQuat));let m=It.subVectors(f,a).length(),v=this.sunDirection.copy(It).divideScalar(m||1),y=null,E=1/0;for(let p of this.bodies.values()){Rt.bodyPosition(p.id,o,p.rootPos),Rt.rotationQuat(p.id,o,p.quat),p.group.position.subVectors(p.rootPos,a),p.fixed.quaternion.copy(p.quat);let k=rt.subVectors(c,p.rootPos);p.dist=k.length();let z=p.body.radius;p.angPx=Math.atan(z/Math.max(p.dist,z*1.0001))/r,p.dist<p.body.soi&&p.body.soi<E&&(y=p,E=p.body.soi)}this.nearestBody=y?y.id:"sola";let R=_s.copy(dt);for(let p of this.bodies.values()){let k=p.body.radius,z=p.uniforms;z.uBodyCenter.value.copy(p.group.position),z.uSunDirW.value.subVectors(f,p.rootPos).normalize(),z.uSunRadiance.value.set(R.r,R.g,R.b).multiplyScalar(me),this._updateOccluders(p,f),p.clouds&&(z.uCloudTime.value=o/(p.body.rotationPeriod*11)%1*Math.PI*2,z.uBodyRotInv.value.setFromMatrix4(Ss.makeRotationFromQuaternion(ee.copy(p.quat).invert())));let H=p.angPx>.45;if(p.group.visible=H,p.lod&&H){ee.copy(p.quat).invert();let I=rt.subVectors(c,p.rootPos).applyQuaternion(ee);if(p.lod.update(I.x,I.y,I.z,r),p===y&&p.dist-k<p.lod.gen.maxHeightBound+2500&&!this._noScatter){p.scatter||(p.scatter=new be(p.body,p.fixed));let J=this._originFixed.subVectors(a,p.rootPos).applyQuaternion(ee);p.scatter.update(I.x,I.y,I.z,J.x,J.y,J.z)}else p.scatter&&p.scatter.setVisible(!1);let F=p.terrainMat.userData.uniforms;if(F.uTime.value=this.time,F.uSunLightDirW.value.copy(v),F.uSunColor.value.set(R.r,R.g,R.b).multiplyScalar(Gt),F.uPixelAngle.value=r,this._updateShine(p,F),p.clouds){let J=p.clouds.material.uniforms;J.uSunColor.value.copy(F.uSunColor.value),J.uPixelAngle.value=r}if(p.oceanMat){let J=p.oceanMat.uniforms;J.uTime.value=this.time,J.uSunColor.value.copy(F.uSunColor.value),J.uPixelAngle.value=r}}p.shell&&(p.shell.mesh.visible=H||p.dist<k*3)}let D=Vt[this.quality];this.service.pump(this._forceSync?1e9:D.buildMs,this._forceSync?1e9:D.maxUploads,this._forceSync);let S=y,L=0,G=0,C=this._tr||(this._tr=[1,1,1]);C[0]=C[1]=C[2]=1;let W=this._up.set(0,1,0),U=1,_=1;if(S){W.subVectors(a,S.rootPos);let p=W.length();if(W.divideScalar(p||1),_=p/S.body.radius,U=W.dot(v),this.cameraAltitude=rt.subVectors(c,S.rootPos).length()-S.body.radius,S.atmoParams){fe(S.atmoParams,_,U,C);let k=S.atmoParams.top;G=1-pt(k-(k-1)*.6,k,rt.length()/S.body.radius)}else{let k=-Math.sqrt(Math.max(0,1-1/(_*_))),z=pt(k-.01,k+.01,U);C[0]=C[1]=C[2]=z}}let V=1,O=ht.sola.radius,j=Math.asin(Math.min(1,O/Math.max(m,O)));for(let p of this.bodies.values()){if(p===S)continue;let k=rt.subVectors(p.rootPos,a),z=k.length();if(k.dot(v)<=0||z>m)continue;let H=Math.asin(Math.min(1,p.body.radius/z)),I=Math.acos(Math.max(-1,Math.min(1,k.dot(v)/z))),F=pt(H-j,H+j,I);V=Math.min(V,Math.max(F,1-H*H/(j*j)))}let X=Math.max(0,Math.min(1,V));this.sunLight.color.setRGB(R.r*C[0]*X,R.g*C[1]*X,R.b*C[2]*X),this.sunLight.intensity=Gt;let N=this.shadowExtent;if(this.sunLight.position.copy(v).multiplyScalar(N*4),this.sunLight.target.position.set(0,0,0),N!==this._shadowExtentApplied){let p=this.sunLight.shadow.camera;p.left=-N,p.right=N,p.top=N,p.bottom=-N,p.near=.5,p.far=N*9,p.updateProjectionMatrix(),this.sunLight.shadow.normalBias=.02*N/40,this._shadowExtentApplied=N}let A=S&&S.atmoParams&&_<S.atmoParams.top?As:ks,P=this._skyCol.set(A[0],A[1],A[2]),B=this._groundCol.set(.004,.004,.005);if(S){if(S.atmoParams){let I=Math.exp(-Math.max(0,_-1)*S.atmoParams.XR*.5);S.skyIrradiance(U,lt);let F=(.25+.75*I)*(.1+.9*X);P.set(lt[0]*F,lt[1]*F,lt[2]*F),pe(S.skyLut,5,U,ft),L=qe(ft)*I*X}let p=ee.copy(S.quat).invert(),k=Ut.copy(W).applyQuaternion(p);ce(S.id,k.x,k.y,k.z,bt),bt.water&&(bt.color[0]=.02,bt.color[1]=.05,bt.color[2]=.09);let z=1-Math.sqrt(Math.max(0,1-1/(_*_))),H=Gt*Math.max(U,0)*X*.35+.02;if(B.set(bt.color[0],bt.color[1],bt.color[2]).multiplyScalar(H*Math.max(z,_<1.2?1:0)*1.6),S.shineSrc){let I=pt(-.1,.3,W.dot(S.shineDir))*.8;P.x+=S.shineE.x*I,P.y+=S.shineE.y*I,P.z+=S.shineE.z*I}P.x=Math.max(P.x,A[0]),P.y=Math.max(P.y,A[1]),P.z=Math.max(P.z,A[2]),B.x=Math.max(B.x,Ne[0]*z*2),B.y=Math.max(B.y,Ne[1]*z*2),B.z=Math.max(B.z,Ne[2]*z*2),this.hemiLight.position.copy(W)}this.hemiLight.color.setRGB(P.x,P.y,P.z),this.hemiLight.groundColor.setRGB(B.x,B.y,B.z),this.hemiLight.intensity=this.hemiScale;let ut=1-pt(8e-4,.02,L),Z=this.sky;Z.starMat.uniforms.uFade.value=ut,Z.starMat.uniforms.uTime.value=this.time,Z.starMat.uniforms.uTwinkle.value=G,Z.starMat.uniforms.uPixelRatio.value=h,Z.dotMat.uniforms.uPixelRatio.value=h,Z.boxMat.uniforms.uFade.value=ut,this._updateSun(t,c,l,f,S,C,G),this._updateDots(c,f,r,ut),this._envTimer-=n,this._envTimer<=0&&(this._envTimer=.4,this._updateEnv(S,W,v,U,_,C,X,B));let st=this._findScene();st&&this.envMap&&(st.environment===null||st.environment===this._envSetOn)&&(st.environment=this.envMap,this._envSetOn=this.envMap)}_updateOccluders(t,e){let o=t.uniforms,s=t.body.radius,n=Ut.subVectors(e,t.rootPos),a=n.length();n.divideScalar(a||1);let l=ht.sola.radius/Math.max(a,ht.sola.radius);o.uSunAngR.value=l;let c=null,u=1/0,d=null,r=1/0;for(let f of this.bodies.values()){if(f===t)continue;let m=rt.subVectors(f.rootPos,t.rootPos),v=m.dot(n);if(v<=0||v>a)continue;let y=Math.sqrt(Math.max(0,m.lengthSq()-v*v)),E=s*1.02+f.body.radius+v*l*1.05;if(y>=E)continue;let R=y/E;R<u?(d=c,r=u,c=f,u=R):R<r&&(d=f,r=R)}let h=(f,m)=>{if(!m){f.set(0,0,0,0);return}let v=rt.subVectors(m.rootPos,t.rootPos).divideScalar(s);f.set(v.x,v.y,v.z,m.body.radius/s)};h(o.uOcc0.value,c),h(o.uOcc1.value,d)}_updateShine(t,e){let o=e.uShineColor.value;if(t.shineE.set(0,0,0),!t.shineSrc){o.set(0,0,0);return}let s=this.bodies.get(t.shineSrc);if(!s){o.set(0,0,0);return}let n=rt.subVectors(s.rootPos,t.rootPos),a=n.length();n.divideScalar(a||1),e.uShineDirW.value.copy(n),t.shineDir.copy(n);let l=Ut.subVectors(this._sunRoot,s.rootPos).normalize(),c=Math.max(-1,Math.min(1,-n.dot(l))),u=Math.acos(c),d=(Math.sin(u)+(Math.PI-u)*c)/Math.PI,r=s.body.radius/Math.max(a,s.body.radius),h=Math.min(zs,Gt*Cs*(2/3)*d*r*r*Hs);o.copy(t.shineTint).multiplyScalar(h),t.shineE.copy(o)}_findScene(){let t=this.root.parent;for(;t&&!t.isScene;)t=t.parent;return t||null}_updateSun(t,e,o,s,n,a,l){let c=this.sky,u=It.subVectors(s,e),d=u.length();u.divideScalar(d);let r=t.far||1e12,h=Math.min(d,r*.45),f=h/d,m=ht.sola.radius*f;c.sun.position.copy(o).addScaledVector(u,h);let v=c.sunMat.uniforms;v.uDisk.value=m,v.uSize.value=m*26,v.uTime.value=this.time;let y=Math.max(a[0],a[1],a[2],1e-4);v.uColor.value.setRGB(1*a[0]/y,.93*a[1]/y,.8*a[2]/y);let E=(a[0]+a[1]+a[2])/3;v.uIntensity.value=l>0?Math.max(.02,Math.min(1,E*1.25))*l+(1-l):1,v.uGlare.value=1-l*.6;let R=c.flareMat.uniforms;R.uSunDirW.value.copy(u);let D=0;if(rt.copy(u).transformDirection(t.matrixWorldInverse.copy(t.matrixWorld).invert()),rt.z<0){Ut.copy(u).multiplyScalar(1e6).add(o).project(t);let S=Math.max(Math.abs(Ut.x),Math.abs(Ut.y));if(D=1-pt(.85,1.15,S),D>0)for(let L of this.bodies.values()){let G=rt.subVectors(L.rootPos,e),C=G.dot(u);if(C<=0||C>d)continue;let W=G.lengthSq()-C*C,U=L.body.radius;if(W<U*U){D=0;break}}}R.uFlare.value=D*Math.min(1,(a[0]+a[1]+a[2])/3*1.2),R.uTint.value.copy(v.uColor.value)}_updateDots(t,e,o,s){let n=this.sky;for(let a=0;a<n.dotIds.length;a++){let l=this.bodies.get(n.dotIds[a]),c=It.subVectors(l.rootPos,t),u=c.length();c.divideScalar(u);let d=l.angPx,r=1-pt(1.2,3,d);if(r<=0||u<l.body.radius*2){n.setDot(a,c,0,0,0,0,0);continue}let h=rt.subVectors(e,l.rootPos).normalize(),f=.5*(1-c.dot(h)),m=Math.min(2.2,Math.max(.9,Math.pow(d*40,.3)))*(.35+.85*f)*(.55+.45*s),v=l.color,y=Math.max(v.r,v.g,v.b,.001),E=m*1.6/y;n.setDot(a,c,(v.r*.7+y*.3)*E,(v.g*.7+y*.3)*E,(v.b*.7+y*.3)*E,r,4.2+Math.min(2.5,d))}n.commitDots()}_updateEnv(t,e,o,s,n,a,l,c){let u=this.envMat.uniforms;u.uUp.value.copy(e),u.uSunDir.value.copy(o),u.uSunColor.value.set(dt.r*a[0],dt.g*a[1],dt.b*a[2]).multiplyScalar(l*Gt);let d=t?Math.sqrt(Math.max(0,1-1/(n*n))):-1.5;if(u.uHorizonCos.value=t?d:2,t&&t.atmoParams){let h=t.atmoParams,f=Math.max(n,1.000001);Nt(h,f,1,s,s,lt),Nt(h,f,.05,s,Math.sqrt(Math.max(0,1-s*s))*.3,ft);let m=.1+.9*l;u.uZenith.value.set(Math.max(lt[0]*m,ct[0]),Math.max(lt[1]*m,ct[1]),Math.max(lt[2]*m,ct[2])),u.uHorizon.value.set(Math.max(ft[0]*m,ct[0]*1.3),Math.max(ft[1]*m,ct[1]*1.3),Math.max(ft[2]*m,ct[2]*1.3));let v=n>h.top?pt(-.3,.2,s):0;u.uLimb.value.set(h.tauR[0],h.tauR[1],h.tauR[2]).multiplyScalar(v*.8)}else u.uZenith.value.set(ct[0]*.5,ct[1]*.5,ct[2]*.5),u.uHorizon.value.set(ct[0]*.5,ct[1]*.5,ct[2]*.5),u.uLimb.value.set(0,0,0);u.uGround.value.copy(c).multiplyScalar(1/Math.max(this.hemiScale,.001)/1.6);let r=[u.uUp.value.x,u.uUp.value.y,u.uUp.value.z,s,n,a[0],a[1],l,c.x].map(h=>Math.round(h*50)).join(",");r!==this._envKey&&(this._envKey=r,this._renderEnv())}dispose(){if(this._disposed)return;this._disposed=!0;for(let e of this.bodies.values())e.dispose();this.bodies.clear(),this.service.dispose(),this.sky.dispose(),this.envGeo.dispose(),this.envMat.dispose(),this.envCubeRT.dispose(),this.envRT?.dispose(),this.pmrem.dispose(),this.sunLight.shadow.map?.dispose();let t=this._findScene();t&&t.environment===this._envSetOn&&(t.environment=null),this.root.removeFromParent()}};export{Uo as a};
