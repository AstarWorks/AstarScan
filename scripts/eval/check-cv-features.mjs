import { cv } from './cv-shim.mjs'

const features = ['ORB', 'AKAZE', 'BRISK', 'SIFT', 'KAZE', 'DescriptorMatcher', 'BFMatcher']
for (const f of features) {
  console.log(`${f}: ${typeof cv[f]}`)
}
process.exit(0)
