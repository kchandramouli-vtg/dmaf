import xml.etree.ElementTree as ET
from typing import Dict

from pydantic.main import BaseModel


class LanguageType(BaseModel):

    data: str = ''
    namespace: Dict[str, str] = {}
    lang: str = ''

    def parse(self):
        LanguageType = ET.fromstring(self.data)
        lang = LanguageType.find('cel-ipre:lang', self.namespace)
        if lang is not None:  # DMAF: Element truthiness is len(children)
            self.lang = lang.text
        self.namespace = None
        self.data = None
