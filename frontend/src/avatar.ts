export const avatarFileLimit=5*1024*1024;
// Keep the profile JSON within the existing 24,000-byte request budget.
export async function prepareAvatar(file:File):Promise<string> {
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('请选择 JPG、PNG 或 WebP 图片');
  if(!file.size||file.size>avatarFileLimit)throw Error('照片须小于 5 MB，请重新选择');
  let bitmap:ImageBitmap;
  try{bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});}catch{throw Error('照片无法读取，请重新选择图片');}
  try{
    if(!bitmap.width||!bitmap.height||bitmap.width*bitmap.height>24_000_000)throw Error('照片尺寸过大，请选择 2400 万像素以内的图片');
    const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
    if(!context)throw Error('当前浏览器无法处理照片，请重试');
    const edge=Math.min(bitmap.width,bitmap.height);
    for(const size of [256,192,128]){
      canvas.width=size;canvas.height=size;context.fillStyle='#f0f3e9';context.fillRect(0,0,size,size);
      context.drawImage(bitmap,(bitmap.width-edge)/2,(bitmap.height-edge)/2,edge,edge,0,0,size,size);
      for(const quality of [.9,.75,.55]){
        const data=canvas.toDataURL('image/jpeg',quality);
        if(!data.startsWith('data:image/jpeg;base64,'))throw Error('照片处理失败，请重试');
        const encoded=data.split(',')[1]!;
        if(encoded.length<=21_332)return encoded;
      }
    }
    throw Error('照片无法压缩为头像，请换一张图片');
  }finally{bitmap.close();}
}
