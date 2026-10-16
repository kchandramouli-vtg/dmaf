import xml.etree.ElementTree as ET
from typing import Dict, List

from pydantic.main import BaseModel


class SpatialLocation(BaseModel):

    data: str = ''
    namespace: Dict[str, str] = {}
    locations: List[str] = []
    places: List[str] = []

    def parse(self):
        spatialLocation = ET.fromstring(self.data)
        locations = spatialLocation.find('cel-ipre:location', self.namespace)
        places = []
        for location in locations:
            places.append(location.text)
        self.places = places
        self.namespace = None
        self.data = None
