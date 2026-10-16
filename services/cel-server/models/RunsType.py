import xml.etree.ElementTree as ET
from typing import Dict

from pydantic.main import BaseModel


class RunsType(BaseModel):

    data: str = ''
    namespace: Dict[str, str] = {}
    number: str = ''
    hasNumerOfRepetitions: str = ''
    hasValidity: str = ''

    def parse(self):
        runsType = ET.fromstring(self.data)
        number = runsType.find('cel-ipre:number', self.namespace)
        hasNumerOfRepetitions = runsType.find(
            'cel-ipre:hasNumerOfRepetitions', self.namespace)
        hasValidity = runsType.find('cel-ipre:hasValidity', self.namespace)
        self.number = number.text
        if hasNumerOfRepetitions is not None:  # DMAF: Element truthiness is len(children)
            self.hasNumerOfRepetitions = hasNumerOfRepetitions.text
        if hasValidity is not None:  # DMAF: Element truthiness is len(children)
            self.hasValidity = hasValidity.text
        self.namespace = None
        self.data = None
