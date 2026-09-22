const { PNG } = require('pngjs');
const SPECTRA6=[[0,0,0],[255,255,255],[255,0,0],[0,255,0],[0,0,255],[255,255,0]];
function quantizeSpectra6(input,palette='spectra6'){
  const png=PNG.sync.read(Buffer.isBuffer(input)?input:Buffer.from(input)),colors=palette==='mono'?SPECTRA6.slice(0,2):SPECTRA6;
  for(let i=0;i<png.data.length;i+=4){
    if(png.data[i+3]<128){png.data[i]=255;png.data[i+1]=255;png.data[i+2]=255;png.data[i+3]=255;continue}
    const r=png.data[i],g=png.data[i+1],b=png.data[i+2];let best=colors[0],dist=Infinity;
    for(const c of colors){const d=(r-c[0])**2+(g-c[1])**2+(b-c[2])**2;if(d<dist){dist=d;best=c}}
    png.data[i]=best[0];png.data[i+1]=best[1];png.data[i+2]=best[2];png.data[i+3]=255;
  }
  return PNG.sync.write(png,{colorType:6,inputColorType:6,inputHasAlpha:true});
}
module.exports={quantizeSpectra6,SPECTRA6};
