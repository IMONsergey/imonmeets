"""Conservative text sentence boundaries for MT; never rewrites translated entities."""
from __future__ import annotations
import re

TITLES={'mr','mrs','ms','dr','prof','sr','jr','st','г','ул','д','им','т','т.е','т.д','т.п'}
CLOSERS='\"\'”’»）)】]'


def split_sentences(text: str, max_segments: int = 32) -> list[str]:
    if not isinstance(text,str):raise TypeError('text must be a string')
    if not text.strip():return []
    if len(text)>8000:raise ValueError('Utterance text exceeds bound')
    segments=[];start=0;i=0
    while i<len(text):
        char=text[i];boundary=char in '!?。！？؟'
        if char=='.':
            previous=text[i-1] if i else ''
            following=text[i+1] if i+1<len(text) else ''
            left=text[:i]
            word=re.search(r'([\w.]+)$',left)
            token=word.group(1) if word else ''
            # Decimal separators, ellipses, titles and initialisms stay intact.
            boundary=not ((previous.isdigit() and following.isdigit()) or previous=='.' or following=='.' or token.lower() in TITLES or (len(token)==1 and token.isalpha()) or re.fullmatch(r'(?:[A-Za-z]\.)+[A-Za-z]',token))
            # Sentence-final clock abbreviations may be followed by a new sentence.
            if token.lower() in {'a.m','p.m'}:
                tail=text[i+1:].lstrip();boundary=not tail or tail[0].isupper()
            if following and not following.isspace() and following not in CLOSERS:boundary=False
        if boundary:
            end=i+1
            while end<len(text) and text[end] in '!?。！？؟'+CLOSERS:end+=1
            part=text[start:end].strip()
            if part:segments.append(part)
            start=end;i=end-1
        i+=1
    rest=text[start:].strip()
    if rest:segments.append(rest)
    if len(segments)>max_segments:raise ValueError('Too many sentence segments')
    return segments
