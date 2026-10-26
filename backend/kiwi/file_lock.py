"""A process lock whose ownership ends on close or process termination."""
import os


class FileLock:
    def __init__(self,path):
        self.path,self.file=path,None

    def acquire(self):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        stream=self.path.open('a+b')
        if stream.tell()==0:
            stream.write(b'0');stream.flush()
        stream.seek(0)
        try:
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(stream.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:
            stream.close();return False
        self.file=stream
        return True

    def close(self):
        if self.file:
            self.file.close();self.file=None
