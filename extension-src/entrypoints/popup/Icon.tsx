export default function Icon({ name, size = 14 }: { name: string; size?: number }) {
  return <img className="popup-icon" src={`/images/popup/${name}.svg`} width={size} height={size} alt="" aria-hidden="true" />;
}
