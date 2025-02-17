import { execSync, exec } from 'node:child_process'

try {

  const { stdout, stderr } = exec('git describe --always --abbrev=0 --dirty')
  stdout?.on('data', d => console.log('data', d))
  stderr?.on('data', d => console.log('data', d))
} catch (e) {
  console.error('err:', e)
}

// export const version = execSync('git describe --always --abbrev=0 --dirty')
//   .toString()
//   .trim();

export const version = 'o'
